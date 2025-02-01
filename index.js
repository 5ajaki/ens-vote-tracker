require("dotenv").config();

const { ethers } = require("ethers");
const fs = require("fs").promises;
const express = require("express");
const path = require("path");

// Config
const config = {
  RPC_URL: process.env.RPC_URL || "http://nethermind.public.dappnode:8545",
  GOVERNOR_ADDRESS:
    process.env.GOVERNOR_ADDRESS ||
    "0x323a76393544d5ecca80cd6ef2a560c6a395b7e3",
  CACHE_DIR: process.env.CACHE_DIR || "./cache",
  PORT: process.env.PORT || 3000,
  CACHE_DURATION: process.env.CACHE_DURATION || 3600, // in seconds
};

const governorABI = [
  "function proposalSnapshot(uint256 proposalId) view returns (uint256)",
  "function getVotes(address account, uint256 blockNumber) view returns (uint256)",
  "event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)",
];

// Update the constants at the top
const DEFAULT_START_BLOCK = 21723989; // Known proposal block
const CHUNK_SIZE = 100000; // Number of blocks per request
const DEFAULT_PROPOSAL_ID =
  "31309365093913580207991288430108338667724061355449265288906484597789511363394"; // New proposal ID
const VOTE_CAST_EVENT =
  "0xb8e138887d0aa13bab447e82de9d5c1777041ecd21ca36ba824ff1e6c07ddda4"; // Actual event signature from the transaction

// Add a debug flag at the top with the other constants
const DEBUG_MODE = false; // Back to using cache

// Add quorum constant at the top with other constants
const QUORUM_VOTES = 1_000_000; // 1 million votes required for quorum

// Add this helper function near the top with other utility functions
function formatNumber(number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(number);
}

async function ensureCacheDir() {
  try {
    await fs.mkdir(config.CACHE_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

async function getCachedData(proposalId) {
  try {
    const data = await fs.readFile(
      path.join(config.CACHE_DIR, `proposal-${proposalId}.json`),
      "utf8"
    );
    const parsed = JSON.parse(data);

    // Check if cache is expired
    if (parsed.timestamp + config.CACHE_DURATION * 1000 < Date.now()) {
      return null;
    }

    return parsed.data;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function cacheData(proposalId, data) {
  const cacheObject = {
    timestamp: Date.now(),
    data: data,
  };

  await fs.writeFile(
    path.join(config.CACHE_DIR, `proposal-${proposalId}.json`),
    JSON.stringify(cacheObject, null, 2)
  );
}

// Add ENS resolution function
async function resolveENSName(address, provider) {
  try {
    const ensName = await provider.lookupAddress(address);
    return ensName ? `${ensName} (${address})` : address;
  } catch (error) {
    console.warn(`Failed to resolve ENS for ${address}:`, error.message);
    return address;
  }
}

async function getVotingData(proposalId) {
  try {
    // Check cache first
    if (!DEBUG_MODE) {
      const cached = await getCachedData(proposalId);
      if (cached) {
        return cached;
      }
    }

    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    const governorContract = new ethers.Contract(
      config.GOVERNOR_ADDRESS,
      governorABI,
      provider
    );

    // Get snapshot block - Add this back
    const snapshotBlock = await governorContract.proposalSnapshot(proposalId);
    if (snapshotBlock === 0n) {
      throw new Error(`Proposal ${proposalId} does not exist`);
    }
    console.log(`Snapshot block: ${snapshotBlock}`);

    const currentBlock = await provider.getBlockNumber();
    let allEvents = [];
    const startBlock = DEFAULT_START_BLOCK;

    for (
      let fromBlock = startBlock;
      fromBlock < currentBlock;
      fromBlock += CHUNK_SIZE
    ) {
      const toBlock = Math.min(fromBlock + CHUNK_SIZE - 1, currentBlock);

      const filter = {
        address: config.GOVERNOR_ADDRESS,
        topics: [VOTE_CAST_EVENT, null],
        fromBlock: fromBlock,
        toBlock: toBlock,
      };

      try {
        const events = await provider.getLogs(filter);
        const matchingEvents = events.filter((event) => {
          const parsed = governorContract.interface.parseLog({
            topics: event.topics,
            data: event.data,
          });
          return parsed.args.proposalId.toString() === proposalId.toString();
        });
        allEvents = allEvents.concat(matchingEvents);
      } catch (error) {
        console.warn(
          `Error fetching chunk ${fromBlock}-${toBlock}:`,
          error.message
        );
      }
    }

    const votes = await Promise.all(
      allEvents.map(async (event) => {
        const block = await provider.getBlock(event.blockNumber);
        const parsed = governorContract.interface.parseLog({
          topics: event.topics,
          data: event.data,
        });

        // Now snapshotBlock is available here
        const votingPower = await governorContract.getVotes(
          parsed.args.voter,
          snapshotBlock
        );

        // Add ENS resolution
        const delegateWithENS = await resolveENSName(
          parsed.args.voter,
          provider
        );

        return {
          delegate: delegateWithENS,
          vote:
            parsed.args.support === 0n
              ? "Against"
              : parsed.args.support === 1n
              ? "For"
              : "Abstain",
          votingPower: ethers.formatUnits(votingPower, 18),
          weight: ethers.formatUnits(parsed.args.weight, 18),
          timestamp: new Date(Number(block.timestamp) * 1000).toLocaleString(),
          reason: parsed.args.reason || "",
        };
      })
    );

    // Cache the results
    if (!DEBUG_MODE) {
      await cacheData(proposalId, votes);
    }

    return votes;
  } catch (error) {
    console.error(`Error in getVotingData:`, error);
    throw error;
  }
}

// Simple express server to view results
const app = express();

function validateProposalId(proposalId) {
  if (!proposalId) {
    throw new Error("Proposal ID is required");
  }
  try {
    // Handle string inputs of large numbers properly
    return BigInt(proposalId.toString());
  } catch (error) {
    throw new Error("Invalid proposal ID format");
  }
}

// First, let's clear the cache directory to force a fresh fetch
async function clearCache() {
  try {
    const files = await fs.readdir(config.CACHE_DIR);
    for (const file of files) {
      await fs.unlink(path.join(config.CACHE_DIR, file));
    }
    console.log("Cache cleared");
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Error clearing cache:", err);
    }
  }
}

// Fix the RPC provider creation
function createProvider(rpcUrl) {
  try {
    return new ethers.JsonRpcProvider(rpcUrl); // Note: JsonRpcProvider instead of providers.JsonRpcProvider
  } catch (error) {
    console.error("Failed to create provider:", error);
    throw error;
  }
}

// Update the RPC status check
async function checkRPCStatus(rpcUrl) {
  try {
    const provider = createProvider(rpcUrl);
    await provider.getNetwork();
    return true;
  } catch (error) {
    console.warn(`RPC check failed for ${rpcUrl}:`, error.message);
    return false;
  }
}

// Update the route handler to use this default
app.get("/", async (req, res) => {
  try {
    const proposalId = validateProposalId(
      req.query.proposal || DEFAULT_PROPOSAL_ID
    );
    const rpcUrl = req.query.rpc || config.RPC_URL;
    const rpcStatus = await checkRPCStatus(rpcUrl);
    const viewFilter = req.query.view || "all"; // new filter parameter
    const sortBy = req.query.sort || "time"; // new sort parameter
    const sortDir = req.query.dir || "desc"; // sort direction

    const votes = await getVotingData(proposalId);
    const stats = calculateVoteStats(votes);

    // Apply view filter
    const filteredVotes = votes.filter((vote) => {
      if (viewFilter === "all") return true;
      if (viewFilter === "for" && vote.vote === "For") return true;
      if (viewFilter === "against" && vote.vote === "Against") return true;
      if (viewFilter === "abstain" && vote.vote === "Abstain") return true;
      return false;
    });

    // Apply sorting
    const sortedVotes = [...filteredVotes].sort((a, b) => {
      if (sortBy === "weight") {
        const weightA = parseFloat(a.weight);
        const weightB = parseFloat(b.weight);
        return sortDir === "desc" ? weightB - weightA : weightA - weightB;
      } else {
        // time
        const timeA = new Date(a.timestamp);
        const timeB = new Date(b.timestamp);
        return sortDir === "desc" ? timeB - timeA : timeA - timeB;
      }
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>ENS DAO Votes - Proposal ${proposalId}</title>
          <style>
              body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', sans-serif;
                  line-height: 1.5;
                  color: #333;
                  max-width: 1200px;
                  margin: 0 auto;
                  padding: 20px 40px;
              }

              h1, h2, h3 {
                  color: #2c3e50;
              }

              .stats-grid {
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 30px;
                  margin: 20px 0;
              }

              .stats-section {
                  background: #f8f9fa;
                  padding: 20px;
                  border-radius: 8px;
                  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
              }

              table {
                  width: 100%;
                  border-collapse: collapse;
                  margin: 20px 0;
                  background: white;
                  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
              }

              th, td {
                  padding: 12px 16px;
                  text-align: left;
                  border-bottom: 1px solid #eee;
              }

              th {
                  background: #f8f9fa;
                  font-weight: 600;
              }

              .view-buttons {
                  margin: 20px 0;
                  display: flex;
                  gap: 10px;
              }

              .view-button {
                  padding: 8px 16px;
                  border: 1px solid #ddd;
                  border-radius: 6px;
                  background: #f8f9fa;
                  cursor: pointer;
                  text-decoration: none;
                  color: #333;
                  transition: all 0.2s ease;
              }

              .view-button:hover {
                  background: #e9ecef;
              }

              .view-button.active {
                  background: #007bff;
                  color: white;
                  border-color: #0056b3;
              }

              .quorum-status {
                  font-weight: 600;
                  padding: 12px;
                  border-radius: 6px;
                  margin: 10px 0;
              }

              .quorum-status.reached {
                  background: #d4edda;
                  color: #155724;
              }

              .quorum-status.needed {
                  background: #fff3cd;
                  color: #856404;
              }

              .votes-needed {
                  color: #856404;
                  font-weight: 600;
              }

              .refresh-note {
                  margin: 20px 0;
                  color: #6c757d;
                  font-style: italic;
              }

              .sort-header {
                  cursor: pointer;
                  text-decoration: none;
                  color: #2c3e50;
              }

              .sort-header:hover {
                  color: #007bff;
              }

              .rpc-form {
                  background: #f8f9fa;
                  padding: 20px;
                  border-radius: 8px;
                  margin: 20px 0;
              }

              input[type="text"] {
                  padding: 8px 12px;
                  border: 1px solid #ddd;
                  border-radius: 4px;
                  font-size: 14px;
                  width: 100%;
                  max-width: 400px;
              }

              button {
                  padding: 8px 16px;
                  background: #007bff;
                  color: white;
                  border: none;
                  border-radius: 4px;
                  cursor: pointer;
                  transition: background 0.2s ease;
              }

              button:hover {
                  background: #0056b3;
              }
          </style>
      </head>
      <body>
          <h1>ENS DAO Votes - Proposal ${proposalId}</h1>
          
          <div class="rpc-form">
              <form id="configForm">
                  <label>RPC URL: 
                      <input type="text" name="rpc" value="${rpcUrl}" size="50">
                      <span class="rpc-status ${
                        rpcStatus ? "active" : "inactive"
                      }" 
                            title="${
                              rpcStatus ? "RPC Active" : "RPC Inactive"
                            }"></span>
                  </label>
                  <button type="submit">Update RPC</button>
              </form>
          </div>

          <div class="refresh-note">
              Last updated: ${new Date().toLocaleString()}
              (Refresh page to update data)
          </div>

          <div class="stats">
              <h2>Voting Statistics</h2>
              <div class="stats-grid">
                  <div class="stats-section">
                      <h3>Vote Counts</h3>
                      <p>Total Votes: ${stats.totalVotes.toLocaleString()}</p>
                      <p>For: ${stats.forCount.toLocaleString()} votes (${formatNumber(
      stats.forVotes
    )} weight)</p>
                      <p>Against: ${stats.againstCount.toLocaleString()} votes (${formatNumber(
      stats.againstVotes
    )} weight)</p>
                      <p>Abstain: ${stats.abstainCount.toLocaleString()} votes (${formatNumber(
      stats.abstainVotes
    )} weight)</p>
                  </div>
                  
                  <div class="stats-section">
                      <h3>Quorum Status</h3>
                      <p class="quorum-status ${
                        stats.hasReachedQuorum ? "reached" : "needed"
                      }">
                          ${
                            stats.hasReachedQuorum
                              ? "✅ Quorum Reached"
                              : "⏳ Quorum Not Reached"
                          }
                      </p>
                      <p>Current Quorum Votes: ${formatNumber(
                        stats.quorumVotes
                      )}</p>
                      <p>Required Quorum: ${formatNumber(QUORUM_VOTES)}</p>
                      ${
                        !stats.hasReachedQuorum
                          ? `<p class="votes-needed">Needs ${formatNumber(
                              stats.votesNeededForQuorum
                            )} more votes</p>`
                          : ""
                      }
                  </div>
              </div>
          </div>

          <div class="view-buttons">
              <a href="?proposal=${proposalId}&rpc=${encodeURIComponent(
      rpcUrl
    )}&view=all&sort=${sortBy}&dir=${sortDir}" 
                 class="view-button ${
                   viewFilter === "all" ? "active" : ""
                 }">All</a>
              <a href="?proposal=${proposalId}&rpc=${encodeURIComponent(
      rpcUrl
    )}&view=for&sort=${sortBy}&dir=${sortDir}" 
                 class="view-button ${
                   viewFilter === "for" ? "active" : ""
                 }">For</a>
              <a href="?proposal=${proposalId}&rpc=${encodeURIComponent(
      rpcUrl
    )}&view=against&sort=${sortBy}&dir=${sortDir}" 
                 class="view-button ${
                   viewFilter === "against" ? "active" : ""
                 }">Against</a>
              <a href="?proposal=${proposalId}&rpc=${encodeURIComponent(
      rpcUrl
    )}&view=abstain&sort=${sortBy}&dir=${sortDir}" 
                 class="view-button ${
                   viewFilter === "abstain" ? "active" : ""
                 }">Abstain</a>
              <a href="#" class="view-button disabled" onclick="alert('Coming soon!')">Not Yet Voted</a>
          </div>

          <table>
              <thead>
                  <tr>
                      <th>Voter</th>
                      <th>Vote</th>
                      <th class="sort-header" onclick="window.location.href='?proposal=${proposalId}&rpc=${encodeURIComponent(
      rpcUrl
    )}&view=${viewFilter}&sort=weight&dir=${
      sortBy === "weight" ? (sortDir === "asc" ? "desc" : "asc") : ""
    }'">
                          Weight ${
                            sortBy === "weight"
                              ? sortDir === "asc"
                                ? "↑"
                                : "↓"
                              : ""
                          }
                      </th>
                      <th class="sort-header" onclick="window.location.href='?proposal=${proposalId}&rpc=${encodeURIComponent(
      rpcUrl
    )}&view=${viewFilter}&sort=time&dir=${
      sortBy === "time" ? (sortDir === "asc" ? "desc" : "asc") : ""
    }'">
                          Time ${
                            sortBy === "time"
                              ? sortDir === "asc"
                                ? "↑"
                                : "↓"
                              : ""
                          }
                      </th>
                      <th>Reason</th>
                  </tr>
              </thead>
              <tbody>
                  ${sortedVotes
                    .map(
                      (vote) => `
                      <tr>
                          <td>${vote.delegate}</td>
                          <td>${vote.vote}</td>
                          <td>${formatNumber(vote.weight)}</td>
                          <td>${vote.timestamp}</td>
                          <td>${vote.reason}</td>
                      </tr>
                  `
                    )
                    .join("")}
              </tbody>
          </table>

          <div class="refresh-note">
              Last updated: ${new Date().toLocaleString()}
              (Refresh page to update data)
          </div>
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    console.error(`Error processing request:`, error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

// Add endpoint for RPC status checks
app.get("/check-rpc", async (req, res) => {
  const rpcUrl = req.query.rpc || config.RPC_URL;
  const status = await checkRPCStatus(rpcUrl);
  res.json({ active: status });
});

// Start server
async function main() {
  try {
    await ensureCacheDir();
    await clearCache(); // Clear cache on startup

    // Try to start server, if port is in use, try next port
    const startServer = (port) => {
      return new Promise((resolve, reject) => {
        const server = app
          .listen(port)
          .on("error", (err) => {
            if (err.code === "EADDRINUSE") {
              console.log(`Port ${port} is busy, trying ${port + 1}...`);
              server.close();
              resolve(startServer(port + 1));
            } else {
              reject(err);
            }
          })
          .on("listening", () => {
            console.log(`Server running at http://localhost:${port}`);
            resolve(server);
          });
      });
    };

    await startServer(config.PORT);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main().catch(console.error);

// Update the calculateVoteStats function
function calculateVoteStats(votes) {
  const stats = votes.reduce(
    (acc, vote) => {
      const weight = parseFloat(vote.weight);
      acc.totalVotes++;
      acc.totalWeight += weight;

      if (vote.vote === "For") {
        acc.forVotes += weight;
        acc.forCount++;
      } else if (vote.vote === "Against") {
        acc.againstVotes += weight;
        acc.againstCount++;
      } else {
        acc.abstainVotes += weight;
        acc.abstainCount++;
      }

      return acc;
    },
    {
      totalVotes: 0,
      totalWeight: 0,
      forVotes: 0,
      forCount: 0,
      againstVotes: 0,
      againstCount: 0,
      abstainVotes: 0,
      abstainCount: 0,
    }
  );

  // Calculate quorum metrics
  stats.quorumVotes = stats.forVotes + stats.abstainVotes;
  stats.hasReachedQuorum = stats.quorumVotes >= QUORUM_VOTES;
  stats.votesNeededForQuorum = Math.max(0, QUORUM_VOTES - stats.quorumVotes);

  return stats;
}

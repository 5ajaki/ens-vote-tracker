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

async function resolveENSName(address, provider) {
  try {
    const ensName = await provider.lookupAddress(address);
    return ensName || address;
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

        return {
          delegate: parsed.args.voter,
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
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 50;

  try {
    const proposalId = validateProposalId(
      req.query.proposal || DEFAULT_PROPOSAL_ID
    );
    const rpcUrl = req.query.rpc || config.RPC_URL;
    const rpcStatus = await checkRPCStatus(rpcUrl);

    const votes = await getVotingData(proposalId);
    const stats = calculateVoteStats(votes);
    const totalVotes = votes.length;
    const totalPages = Math.ceil(totalVotes / perPage);
    const paginatedVotes = votes.slice((page - 1) * perPage, page * perPage);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>ENS DAO Votes - Proposal ${proposalId}</title>
          <style>
              table { border-collapse: collapse; width: 100%; }
              th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
              th { background-color: #f2f2f2; }
              tr:nth-child(even) { background-color: #f9f9f9; }
              .rpc-status {
                  display: inline-block;
                  width: 12px;
                  height: 12px;
                  border-radius: 50%;
                  margin-left: 8px;
              }
              .rpc-status.active {
                  background-color: #4CAF50;
              }
              .rpc-status.inactive {
                  background-color: #f44336;
              }
              .rpc-form {
                  margin: 20px 0;
                  padding: 15px;
                  background-color: #f5f5f5;
                  border-radius: 4px;
              }
              .rpc-form input[type="text"] {
                  width: 400px;
                  padding: 8px;
                  margin-right: 8px;
              }
              .refresh-note {
                  margin: 10px 0;
                  color: #666;
                  font-style: italic;
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
              <p>Total Votes: ${stats.totalVotes}</p>
              <p>For: ${stats.forCount} votes (${Number(stats.forVotes).toFixed(
      2
    )} weight)</p>
              <p>Against: ${stats.againstCount} votes (${Number(
      stats.againstVotes
    ).toFixed(2)} weight)</p>
              <p>Abstain: ${stats.abstainCount} votes (${Number(
      stats.abstainVotes
    ).toFixed(2)} weight)</p>
          </div>

          <form id="proposalForm">
              <input type="hidden" name="rpc" value="${rpcUrl}">
              <label>Proposal ID: 
                  <input type="text" name="proposal" value="${proposalId}">
              </label>
              <button type="submit">Load Proposal</button>
          </form>

          <table>
              <thead>
                  <tr>
                      <th>Voter</th>
                      <th>Vote</th>
                      <th>Weight</th>
                      <th>Time</th>
                      <th>Reason</th>
                  </tr>
              </thead>
              <tbody>
                  ${paginatedVotes
                    .map(
                      (vote) => `
                      <tr>
                          <td>${vote.delegate}</td>
                          <td>${vote.vote}</td>
                          <td>${Number(vote.weight).toFixed(2)}</td>
                          <td>${vote.timestamp}</td>
                          <td>${vote.reason}</td>
                      </tr>
                  `
                    )
                    .join("")}
              </tbody>
          </table>

          <div class="pagination">
              ${
                page > 1
                  ? `<a href="?proposal=${proposalId}&page=${
                      page - 1
                    }&rpc=${encodeURIComponent(rpcUrl)}">Previous</a>`
                  : ""
              }
              Page ${page} of ${totalPages}
              ${
                page < totalPages
                  ? `<a href="?proposal=${proposalId}&page=${
                      page + 1
                    }&rpc=${encodeURIComponent(rpcUrl)}">Next</a>`
                  : ""
              }
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

// Add voting statistics calculation
function calculateVoteStats(votes) {
  return votes.reduce(
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
}

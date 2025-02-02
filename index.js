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

// Add after other constants
const DELEGATES_FILE = "delegates.json";

// Add ENS token contract details near the top with other constants
const ENS_TOKEN_ADDRESS = "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72";
const ENS_TOKEN_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function delegates(address account) view returns (address)",
  "function getPastVotes(address account, uint256 blockNumber) view returns (uint256)",
];

// Update the loadDelegates function to handle the JSON structure
async function loadDelegates() {
  try {
    const data = await fs.readFile(DELEGATES_FILE, "utf8");
    const parsed = JSON.parse(data);
    return parsed.delegates || []; // Return the delegates array from the JSON structure
  } catch (error) {
    console.error("Error loading delegates:", error);
    return [];
  }
}

// Add this new function to get delegate snapshot
async function getDelegateSnapshot(proposalId, snapshotBlock, provider) {
  try {
    // Check for existing snapshot - this data is immutable once created
    const snapshotFile = path.join(
      config.CACHE_DIR,
      `snapshot-${proposalId}.json`
    );
    try {
      const cached = await fs.readFile(snapshotFile, "utf8");
      console.log(`Using cached immutable snapshot for proposal ${proposalId}`);
      return JSON.parse(cached);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // Only continue if file doesn't exist
    }

    // If we get here, we need to create the snapshot for the first time
    console.log(
      `Creating new immutable snapshot for proposal ${proposalId} at block ${snapshotBlock}...`
    );
    const delegates = await loadDelegates();

    // Create ENS token contract instance
    const ensToken = new ethers.Contract(
      ENS_TOKEN_ADDRESS,
      ENS_TOKEN_ABI,
      provider
    );

    // Get voting power for each delegate at snapshot block
    const snapshot = await Promise.all(
      delegates.map(async (delegate) => {
        try {
          // Get actual voting power at snapshot block
          const votingPower = await ensToken.getPastVotes(
            delegate.address,
            snapshotBlock
          );
          const votingPowerFormatted = ethers.formatUnits(votingPower, 18);

          return {
            address: delegate.address,
            expectedVotingPower: delegate.votingPower,
            actualVotingPower: parseFloat(votingPowerFormatted),
            delegations: delegate.delegations,
            onChainVotes: delegate.onChainVotes,
            rank: delegate.rank,
            hasVotingPowerChanged:
              Math.abs(
                delegate.votingPower - parseFloat(votingPowerFormatted)
              ) > 0.1,
          };
        } catch (error) {
          console.warn(
            `Failed to get votes for ${delegate.address}:`,
            error.message
          );
          return null;
        }
      })
    );

    // Filter out nulls and sort by actual voting power
    const validSnapshot = snapshot
      .filter((d) => d !== null)
      .sort((a, b) => b.actualVotingPower - a.actualVotingPower);

    // Add rankings and voting power changes
    const snapshotWithRanks = validSnapshot.map((delegate, index) => ({
      ...delegate,
      currentRank: index + 1,
      rankChange: delegate.rank - (index + 1),
      votingPowerChange:
        delegate.actualVotingPower - delegate.expectedVotingPower,
    }));

    // Log significant changes
    snapshotWithRanks
      .filter(
        (d) =>
          Math.abs(d.votingPowerChange) > 1000 || Math.abs(d.rankChange) > 5
      )
      .forEach((d) => {
        console.log(`Significant change for ${d.address}:
          Voting Power: ${d.expectedVotingPower} -> ${d.actualVotingPower} (${
          d.votingPowerChange > 0 ? "+" : ""
        }${d.votingPowerChange.toFixed(2)})
          Rank: ${d.rank} -> ${d.currentRank} (${d.rankChange > 0 ? "+" : ""}${
          d.rankChange
        })`);
      });

    // Cache the snapshot (this will never need to be updated)
    await fs.writeFile(
      snapshotFile,
      JSON.stringify(snapshotWithRanks, null, 2)
    );
    console.log(`Immutable snapshot cached for proposal ${proposalId}`);

    return snapshotWithRanks;
  } catch (error) {
    console.error("Error creating delegate snapshot:", error);
    throw error;
  }
}

// Update the number formatting function
function formatNumber(number) {
  const num = parseFloat(number);
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(num);
}

// For stats, let's keep the full numbers but add K notation in parentheses for large values
function formatStatNumber(number) {
  const num = parseFloat(number);
  const fullFormat = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(num);

  if (num >= 1000) {
    return `${fullFormat} (${(num / 1000).toFixed(1)}K)`;
  }
  return fullFormat;
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

// Update the resolveENSName function to include HTML formatting
async function resolveENSName(address, provider) {
  try {
    const ensName = await provider.lookupAddress(address);
    return ensName
      ? `<span class="ens-name">${ensName}</span> <span class="address">(${address})</span>`
      : `<span class="address">${address}</span>`;
  } catch (error) {
    console.warn(`Failed to resolve ENS for ${address}:`, error.message);
    return `<span class="address">${address}</span>`;
  }
}

// Update the getVotingData function to use the new snapshot
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

    // Get snapshot block
    const snapshotBlock = await governorContract.proposalSnapshot(proposalId);
    if (snapshotBlock === 0n) {
      throw new Error(`Proposal ${proposalId} does not exist`);
    }
    console.log(`Snapshot block: ${snapshotBlock}`);

    // Get delegate snapshot with actual voting power at snapshot block
    const delegatesAtSnapshot = await getDelegateSnapshot(
      proposalId,
      snapshotBlock,
      provider
    );
    console.log(
      `Found ${delegatesAtSnapshot.length} delegates with voting power`
    );

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

    // When returning results, include the delegate snapshot
    const result = {
      votes: votes,
      delegateSnapshot: delegatesAtSnapshot,
      snapshotBlock: Number(snapshotBlock),
      snapshotStats: {
        totalDelegates: delegatesAtSnapshot.length,
        significantChanges: delegatesAtSnapshot.filter(
          (d) => d.hasVotingPowerChanged
        ).length,
        topDelegatesByPower: delegatesAtSnapshot.slice(0, 10),
      },
    };

    // Cache the results
    if (!DEBUG_MODE) {
      await cacheData(proposalId, result);
    }

    return result;
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

    let filteredVotes = votes.votes;
    let tableData = [];

    if (viewFilter === "notvoted") {
      tableData = await getNotVotedDelegates(
        votes.delegateSnapshot,
        votes.votes
      );
    } else if (viewFilter === "for") {
      filteredVotes = votes.votes.filter((v) => v.vote === "For");
      tableData = filteredVotes;
    } else if (viewFilter === "against") {
      filteredVotes = votes.votes.filter((v) => v.vote === "Against");
      tableData = filteredVotes;
    } else if (viewFilter === "abstain") {
      filteredVotes = votes.votes.filter((v) => v.vote === "Abstain");
      tableData = filteredVotes;
    } else {
      tableData = votes.votes;
    }

    // Apply sorting
    const sortedVotes = [...tableData].sort((a, b) => {
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

    // Update the table HTML generation to use the correct template based on view
    const tableHTML =
      viewFilter === "notvoted"
        ? await generateNotVotedTable(sortedVotes)
        : `
  <table class="votes-table">
    <thead>
      <tr>
        <th>Voter</th>
        <th>Vote</th>
        <th class="sort-header" onclick="window.location.href='?proposal=${proposalId}&rpc=${encodeURIComponent(
            rpcUrl
          )}&view=${viewFilter}&sort=weight&dir=${
            sortBy === "weight" ? (sortDir === "asc" ? "desc" : "asc") : ""
          }'">
          Weight ${sortBy === "weight" ? (sortDir === "asc" ? "↑" : "↓") : ""}
        </th>
        <th class="sort-header" onclick="window.location.href='?proposal=${proposalId}&rpc=${encodeURIComponent(
            rpcUrl
          )}&view=${viewFilter}&sort=time&dir=${
            sortBy === "time" ? (sortDir === "asc" ? "desc" : "asc") : ""
          }'">
          Time ${sortBy === "time" ? (sortDir === "asc" ? "↑" : "↓") : ""}
        </th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody>
      ${sortedVotes
        .map((vote) => {
          const address = vote.delegate.match(/0x[a-fA-F0-9]{40}/)[0];
          return `
          <tr>
            <td>
              ${vote.delegate.replace(
                address,
                `<a href="https://etherscan.io/address/${address}" target="_blank" class="address-link">${address.substring(
                  0,
                  6
                )}...${address.substring(38)}</a>`
              )}
            </td>
            <td>${vote.vote}</td>
            <td class="voting-power">${formatNumber(vote.weight)}</td>
            <td>${vote.timestamp}</td>
            <td style="text-align: center">
              ${
                vote.reason
                  ? `<span title="${vote.reason}" class="reason-icon">ℹ️</span>`
                  : ""
              }
            </td>
          </tr>
        `;
        })
        .join("")}
    </tbody>
  </table>
`;

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

              .ens-name {
                font-weight: 600;
                font-size: 1.1em;
                color: #2c3e50;
              }
              
              .address {
                color: #6c757d;
                font-size: 0.9em;
              }

              .proposal-header {
                  display: flex;
                  align-items: baseline;
                  gap: 10px;
              }
              
              .proposal-id {
                  font-size: 0.8em;
                  color: #6c757d;
                  font-weight: normal;
                  white-space: nowrap;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  max-width: 200px;
              }

              .votes-table {
                  width: 100%;
                  border-collapse: separate;
                  border-spacing: 0;
                  margin: 20px 0;
                  background: white;
                  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                  border-radius: 8px;
              }

              .votes-table th {
                  background: #f8f9fa;
                  padding: 16px;
                  text-align: left;
                  font-weight: 600;
                  color: #2c3e50;
                  border-bottom: 2px solid #dee2e6;
              }

              .votes-table td {
                  padding: 12px 16px;
                  border-bottom: 1px solid #eee;
                  vertical-align: middle;
              }

              .votes-table tr:last-child td {
                  border-bottom: none;
              }

              .votes-table tr:hover {
                  background-color: #f8f9fa;
              }

              .ens-name {
                  font-weight: 600;
                  font-size: 1.1em;
                  color: #2c3e50;
                  display: block;
              }

              .address-link {
                  color: #6c757d;
                  font-size: 0.9em;
                  text-decoration: none;
              }

              .address-link:hover {
                  color: #007bff;
              }

              .voting-power {
                  font-weight: 600;
                  color: #2c3e50;
              }

              .reason-icon {
                  display: inline-block;
                  width: 20px;
                  height: 20px;
                  line-height: 20px;
                  text-align: center;
                  border-radius: 50%;
                  background: #f8f9fa;
                  color: #6c757d;
                  cursor: help;
              }
          </style>
      </head>
      <body>
          <div class="proposal-header">
              <h1>ENS DAO Votes</h1>
              <span class="proposal-id">Proposal: ${proposalId}</span>
          </div>
          
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
                      <p>For: ${stats.forCount.toLocaleString()} votes (${formatStatNumber(
      stats.forVotes
    )} weight)</p>
                      <p>Against: ${stats.againstCount.toLocaleString()} votes (${formatStatNumber(
      stats.againstVotes
    )} weight)</p>
                      <p>Abstain: ${stats.abstainCount.toLocaleString()} votes (${formatStatNumber(
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
                      <p>Current Quorum Votes: ${formatStatNumber(
                        stats.quorumVotes
                      )}</p>
                      <p>Required Quorum: ${formatStatNumber(QUORUM_VOTES)}</p>
                      ${
                        !stats.hasReachedQuorum
                          ? `<p class="votes-needed">Needs ${formatStatNumber(
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
              <a href="?proposal=${proposalId}&rpc=${encodeURIComponent(
      rpcUrl
    )}&view=notvoted&sort=${sortBy}&dir=${sortDir}" 
                 class="view-button ${
                   viewFilter === "notvoted" ? "active" : ""
                 }">Not Yet Voted</a>
          </div>

          ${tableHTML}

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
function calculateVoteStats(data) {
  const stats = data.votes.reduce(
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

async function getNotVotedDelegates(delegateSnapshot, votes) {
  // Create a Set of addresses that have voted for quick lookup
  const votedAddresses = new Set(
    votes
      .map((vote) => {
        const match = vote.delegate.match(/0x[a-fA-F0-9]{40}/);
        return match ? match[0].toLowerCase() : null;
      })
      .filter((addr) => addr !== null)
  );

  // Filter out specific address and those who have voted
  return delegateSnapshot
    .filter((delegate) => {
      const hasNotVoted = !votedAddresses.has(delegate.address.toLowerCase());
      const hasSignificantPower = delegate.actualVotingPower >= 1000;
      const isNotExcluded =
        delegate.address.toLowerCase() !==
        "0x552df471a4c7fea11ea8d7a7b0acc6989b902a95";
      return hasNotVoted && hasSignificantPower && isNotExcluded;
    })
    .sort((a, b) => b.actualVotingPower - a.actualVotingPower);
}

async function generateNotVotedTable(delegates) {
  const provider = new ethers.JsonRpcProvider(config.RPC_URL);

  const delegatesWithENS = await Promise.all(
    delegates.map(async (delegate) => ({
      ...delegate,
      resolvedName: await resolveENSName(delegate.address, provider),
    }))
  );

  return `
    <table class="votes-table">
      <thead>
        <tr>
          <th>Delegate</th>
          <th>Voting Power</th>
        </tr>
      </thead>
      <tbody>
        ${delegatesWithENS
          .map(
            (delegate) => `
          <tr>
            <td>
              <span class="ens-name">${delegate.resolvedName}</span>
              <a href="https://etherscan.io/address/${delegate.address}" 
                 target="_blank" 
                 class="address-link">
                ${delegate.address.substring(
                  0,
                  6
                )}...${delegate.address.substring(38)}
              </a>
            </td>
            <td class="voting-power">${formatNumber(
              delegate.actualVotingPower
            )}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function generateVotesTable(votes) {
  return `
    <table class="votes-table">
      <thead>
        <tr>
          <th>Delegate</th>
          <th>Vote</th>
          <th>Weight</th>
          <th>Time</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        ${votes
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
  `;
}

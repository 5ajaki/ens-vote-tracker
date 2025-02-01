# ENS DAO Vote Viewer

A simple web application to view and track votes for ENS DAO governance proposals.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
node index.js
```

3. Visit `http://localhost:3000` in your browser

## Configuration

The application can be configured through environment variables or through the UI:

- RPC_URL: Ethereum RPC endpoint
- GOVERNOR_ADDRESS: ENS DAO Governor contract address
- PORT: Server port (default: 3000)
- CACHE_DURATION: Cache duration in seconds (default: 3600)

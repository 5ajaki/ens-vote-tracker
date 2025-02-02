# 🗳️ ENS DAO Vote Viewer

A sleek, real-time dashboard for tracking ENS DAO governance proposals. Watch democracy in action as votes roll in, track delegate participation, and monitor quorum progress.

## ✨ Features

- 🔄 Real-time vote tracking
- 📊 Detailed voting statistics and quorum progress
- 👥 Delegate participation monitoring
- 🏷️ ENS name resolution
- 🔍 Multiple view filters (All, For, Against, Abstain, Not Voted)
- 💾 Smart caching system for optimal performance

## 🚀 Quick Start

1. Clone and install dependencies:

```bash
git clone https://github.com/5ajaki/ens-vote-tracker.git
cd ens-dao-vote-viewer
npm install
```

2. Launch the server:

```bash
node index.js
```

3. Visit `http://localhost:3000` in your browser and start exploring!

## ⚙️ Configuration

Configure through environment variables or the UI:

| Variable           | Description               | Default                                  |
| ------------------ | ------------------------- | ---------------------------------------- |
| `RPC_URL`          | Ethereum RPC endpoint     | `http://nethermind.public.dappnode:8545` |
| `GOVERNOR_ADDRESS` | ENS DAO Governor contract | `0x323a76...7e3`                         |
| `PORT`             | Server port               | `3000`                                   |
| `CACHE_DURATION`   | Cache duration (seconds)  | `3600`                                   |

## 🔒 Cache Management

The application maintains a smart cache system to optimize performance and reduce RPC calls. Cache is automatically cleared on server restart, ensuring fresh data when needed.

## 🤝 Contributing

Contributions are welcome! Feel free to:

- Submit bug reports
- Propose new features
- Create pull requests

## 📜 License

MIT License - See LICENSE file for details

---

<div align="center">
Made with ❤️ for the ENS DAO community
</div>

#!/usr/bin/env node
// Stand-in for nvidia-smi in the browser tests: one card, the fields the dashboard queries.
process.stdout.write(`NVIDIA Fake GPU 16GB, ${40 + Math.floor(Math.random() * 60)}, 11800, 16303, 66, 210.5, 300.00\n`);

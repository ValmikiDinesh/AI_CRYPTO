import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const PORT = process.env.PORT || 5050;
  const baseUrl = `http://127.0.0.1:${PORT}/api`;

  console.log("Verifying reset backend routes locally on server...");
  try {
    const tradesRes = await axios.get(`${baseUrl}/trades`);
    console.log("\n1. GET /api/trades result:");
    console.log(`Success: ${tradesRes.data.success}`);
    console.log(`Returned Trades Count: ${tradesRes.data.data.length}`);
    console.log(`Total Trades count in pagination: ${tradesRes.data.pagination.total}`);

    const statsRes = await axios.get(`${baseUrl}/trades/stats`);
    console.log("\n2. GET /api/trades/stats result:");
    console.log("Stats:", JSON.stringify(statsRes.data.data, null, 2));

    const perfRes = await axios.get(`${baseUrl}/portfolio/performance`);
    console.log("\n3. GET /api/portfolio/performance result:");
    console.log("Performance:", JSON.stringify(perfRes.data.data, null, 2));

  } catch (err) {
    console.error("Verification failed:", err.message);
  }
}

run().catch(console.error);

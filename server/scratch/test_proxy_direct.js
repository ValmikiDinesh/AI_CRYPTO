import axios from 'axios';
import 'dotenv/config';

async function run() {
  const proxyUrl = process.env.BINANCE_PROXY;
  const match = proxyUrl.match(/http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
  const [_, username, password, host, port] = match;
  
  const testUrl = async (url) => {
    console.log(`Testing direct request to: ${url}`);
    const axiosConfig = {
      url: url,
      method: 'GET',
      proxy: {
        protocol: 'http',
        host: host,
        port: parseInt(port),
        auth: { username, password }
      },
      timeout: 10000
    };
    try {
      const res = await axios(axiosConfig);
      console.log(`  SUCCESS! Status: ${res.status}`);
    } catch (err) {
      console.log(`  FAILED! Error: ${err.message}`);
      if (err.response) {
        console.log(`  Response Status: ${err.response.status}`);
        console.log(`  Response Data: ${JSON.stringify(err.response.data)}`);
      }
    }
  };
  
  await testUrl('https://demo-fapi.binance.com/fapi/v1/exchangeInfo');
  await testUrl('https://fapi.binance.com/fapi/v1/exchangeInfo');
}

run().catch(console.error);

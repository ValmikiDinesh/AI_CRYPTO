import '../config/env.js';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import axios from 'axios';
import { getExchange } from '../services/exchangeService.js';

async function run() {
  await connectDB();
  try {
    const exchange = getExchange();
    console.log('isDemo:', exchange.isDemo);
    
    const auth = await exchange._signRequest('GET', '/futures/wallet_balance');
    console.log('Generated auth headers:', auth ? 'Yes (headers generated)' : 'No (auth is null)');
    
    if (auth) {
      try {
        console.log('Sending request to CoinSwitch...');
        const res = await axios.get(`https://coinswitch.co/trade/api/v2/futures/wallet_balance`, auth);
        console.log('Response Status:', res.status);
        console.log('Response Data:', JSON.stringify(res.data, null, 2));
      } catch (err) {
        console.error('API request failed:');
        if (err.response) {
          console.error('Status:', err.response.status);
          console.error('Data:', JSON.stringify(err.response.data, null, 2));
        } else {
          console.error(err.message);
        }
      }
    }
  } catch (err) {
    console.error('Error during test:', err);
  }
  await mongoose.connection.close();
}
run();

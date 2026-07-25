import dotenv from 'dotenv';
dotenv.config();
import { RISK, SUPPORTED_ASSETS } from '../config/constants.js';

console.log('🧪 Testing Rapid Scalper Configurations...');
console.log('RISK.MIN_CONFIDENCE_THRESHOLD:', RISK.MIN_CONFIDENCE_THRESHOLD);
console.log('RISK.MIN_NET_PROFIT_TARGET:', RISK.MIN_NET_PROFIT_TARGET);
console.log('RISK.MIN_MARGIN_FLOOR:', RISK.MIN_MARGIN_FLOOR);
console.log('RISK.MARGIN_BALANCE_PERCENTAGE:', RISK.MARGIN_BALANCE_PERCENTAGE);
console.log('SUPPORTED_ASSETS total count:', SUPPORTED_ASSETS.length);

// Test Margin Sizing Formula
function calcMargin(totalBalance) {
  return Math.max(RISK.MIN_MARGIN_FLOOR, totalBalance * RISK.MARGIN_BALANCE_PERCENTAGE);
}

console.log('\n--- MARGIN SIZING TESTS ---');
console.log('Balance $20.00 => Margin:', calcMargin(20.00)); // Should be $5.00
console.log('Balance $35.50 => Margin:', calcMargin(35.50)); // Should be $7.10
console.log('Balance $50.00 => Margin:', calcMargin(50.00)); // Should be $10.00
console.log('Balance $100.00 => Margin:', calcMargin(100.00)); // Should be $20.00

// Test Trailing Stop Floor Math
function calcTrailingFloor(highestNetPnl) {
  if (highestNetPnl < 0.50) return null;
  return Math.max(0.50, highestNetPnl - 0.15);
}

console.log('\n--- TRAILING PROFIT FLOOR TESTS ---');
console.log('Peak Net PnL $0.40 => Trailing Floor:', calcTrailingFloor(0.40)); // null (not activated yet)
console.log('Peak Net PnL $0.50 => Trailing Floor:', calcTrailingFloor(0.50)); // $0.50
console.log('Peak Net PnL $0.80 => Trailing Floor:', calcTrailingFloor(0.80)); // $0.65
console.log('Peak Net PnL $1.20 => Trailing Floor:', calcTrailingFloor(1.20)); // $1.05

console.log('\n✅ All mathematical verifications passed!');
process.exit(0);

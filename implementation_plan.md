# Implementation Plan: Dynamic Profit Recalculation & Volatility Monitoring Engine

This plan outlines the design and integration of the Dynamic Recalculation Engine, the Intelligent Monitoring Agent, the advanced profit-optimization filters, and real-time frontend dashboard displays.

---

## 1. User Review Required

> [!IMPORTANT]
> This implementation introduces a fully automated, event-driven parameter control system. Once deployed, the static configurations for Take Profit and Basket Profit in your `.env` or database settings will be overridden by the dynamic calculations computed in real-time.
>
> A global switch `DYNAMIC_ENGINE_ENABLED` will be added to `.env` to allow you to disable all new logic and revert instantly to your original trading parameters.

---

## 2. Open Questions

> [!NOTE]
> 1. Which exchanges are currently connected (e.g., Binance, exchange APIs)? We will need to verify that we can fetch real-time order books (to estimate slippage) and historical price data for volatility calculations.
> 2. Do we have a scheduler (like `cron` or a background loop) running on the server to update the Day-of-Week metrics, or should we execute this as a scheduled daily script?

---

## 3. Proposed Changes

### Component 1: Database & Configuration Updates
We need to store historical volatility profiles (especially by Day of Week), trade run-up metrics, macro indicators, and configuration flags.

* **[MODIFY] [.env](file:///c:/AI_CRYPTO/server/.env)**: Add `DYNAMIC_ENGINE_ENABLED=true` to toggle the entire feature on or off.
* **[NEW] [volatility_history.js](file:///C:/Users/Nanda%20Sai/.gemini/antigravity-ide/server/models/volatility_history.js)**: Database model to store daily volatility ranges (High/Low) and average volatility per weekday (Monday–Sunday) for each asset.
* **[MODIFY] [trade.js](file:///C:/Users/Nanda%20Sai/.gemini/antigravity-ide/server/models/trade.js)**: Add fields to track:
  * `max_profit_reached` (MFE)
  * `current_pullback`
  * `locked_min_profit` (the price where Stop Loss is moved to guarantee profit)

---

### Component 2: The Intelligent Monitoring Agent
A background service running continuously to update metrics.

* **[NEW] [monitoring_agent.js](file:///C:/Users/Nanda%20Sai/.gemini/antigravity-ide/server/services/monitoring_agent.js)**:
  * **Day-of-Week Tracker**: Aggregates the last 4-8 weeks of data to update weekday volatility metrics.
  * **MFE/MAE Tracker**: Listens to active positions, logs the highest price reached, and dynamically updates the pullback percentage.
  * **Liquidity & Slippage Estimator**: Queries the exchange order book depth to estimate slippage based on position size.
  * **Trend Momentum Analyzer**: Uses technical indicators (EMA/RSI) to determine market direction.
  * **Market Regime Detector**: Monitors Bitcoin's macro trend (e.g. BTC 200 SMA) to flag Bull vs. Bear market states.
  * **Correlation Analyzer**: Calculates real-time correlation matrix between all active open positions.
  * **Balance Monitor**: Listens for net worth updates and vault sweeping events to trigger parameter scaling.

---

### Component 3: The Recalculation & Execution Engine
Handles the math and modifies target parameters on trade events.

* **[NEW] [recalculation_engine.js](file:///C:/Users/Nanda%20Sai/.gemini/antigravity-ide/server/services/recalculation_engine.js)**:
  * **Dynamic Asset TP**: Sets trailing activations, trailing distances, and locks minimum profit thresholds.
  * **Dynamic Category BP (CBP)**: Recalculates category-wide profit targets.
  * **Dynamic Global BP (GBP)**: Recalculates the master portfolio target.
  * **Volatility-Based Position Sizer**: Suggests entry sizes based on weekday volatility.
  * **Regime-Based Buffer Sizer**: Adapts trailing distances and Stop Loss tightness depending on Bull/Bear state.
  * **Correlation Cap Adjuster**: Reduces GBP and tightens Stop Losses when asset correlation is critically high.

---

### Component 4: Integration with Trading Flow & API

* **[MODIFY] [trade_executor.js](file:///C:/Users/Nanda%20Sai/.gemini/antigravity-ide/server/services/trade_executor.js)**:
  * Trigger the sizer before opening a trade.
  * Trigger `recalculateAll()` whenever a new trade opens, closes, or when the monitoring agent detects a significant volatility shift.
  * **Condition Check**: Wrap core triggers in a check for `process.env.DYNAMIC_ENGINE_ENABLED === 'true'`. If false, execute standard static targets.
* **[MODIFY] [portfolio_service.js]** (or active balance updater script):
  * Trigger `recalculateAll()` whenever a profit-sweep occurs or portfolio balance is reset to `$1,000` to adjust dynamic targets to the new capital baseline.
* **[NEW] [portfolio_routes.js / controller]**:
  * Expose an API endpoint (`/api/portfolio/targets`) to return real-time targets (Asset TP, CBP, GBP) and active trade stats (MFE, locked profit, pullback) to the frontend.

---

### Component 5: Front-end Dashboard Updates
Visually display dynamic profit parameters changing in real-time.

* **[MODIFY] [dashboard.html / dashboard.js]** (or active frontend files):
  * **Global BP (GBP) Card**: A header widget showing the overall portfolio target, floating profit, and a progress bar.
  * **Category BP (CBP) Panel**: A list showing targets for each active category (e.g., L1, Memes) with status progress.
  * **Active Positions Table Columns**: Add columns to show "Locked Profit" (guaranteed stop-loss level) and "Dynamic Trailing Stop" prices next to open positions.
  * **Real-time Updates**: Implement polling or WebSocket listeners on the frontend to update these values automatically without page refresh.

---

## 4. Verification Plan

### Automated Tests
* Unit tests for the Recalculation Engine mathematically verifying that:
  * Highly volatile assets get larger trailing distances.
  * Low-liquidity positions get higher slippage buffers.
  * High-correlation baskets result in lower GBP targets.
  * Bear market regimes trigger tighter trailing limits and faster break-even locks.

### Manual Verification
* Simulate dummy trades on a staging/paper-trading account.
* Verify that setting `DYNAMIC_ENGINE_ENABLED=false` bypasses all logic and uses original static targets.
* Verify that performing a profit sweep (resetting balance to `$1,000`) correctly triggers re-calibration of targets in logs.
* Verify that opening a new trade with `DYNAMIC_ENGINE_ENABLED=true` instantly triggers recalculation events visible in the server logs.
* Open the frontend dashboard and confirm that GBP, CBP, and Asset TP targets update dynamically on-screen as trade states change.

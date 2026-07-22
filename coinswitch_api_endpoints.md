# 🪙 CoinSwitch Pro API Endpoints Used by the Trading Bot

All endpoints are built relative to the Base URL: `https://coinswitch.co/trade/api/v2`

---

## 1. Public Market Data Endpoints
These endpoints are public and do not require private key signing.

* **Sync Server Time**:
  * **Method**: `GET`
  * **Path**: `/time`
  * **Usage**: Syncs clock drift to ensure signatures pass validation.
  
* **Get Market Instrument Information**:
  * **Method**: `GET`
  * **Path**: `/futures/instrument_info?exchange=EXCHANGE_2`
  * **Usage**: Loads precision limits, lot step sizes, and min/max order sizes.
  
* **Get Ticker Prices**:
  * **Method**: `GET`
  * **Path**: `/futures/all-pairs/ticker?exchange=EXCHANGE_2`
  * **Usage**: Streams the latest mark/last price of all perpetual contracts.
  
* **Get Candle/Kline History**:
  * **Method**: `GET`
  * **Path**: `/futures/klines?symbol={symbol}&interval={interval}&limit={limit}&exchange=EXCHANGE_2`
  * **Usage**: Fetches historical OHLCV data to compute technical indicators.
  
* **Get Order Book Depth**:
  * **Method**: `GET`
  * **Path**: `/futures/orderbook?symbol={symbol}&limit={limit}`
  * **Usage**: Checks buy/sell depth for dynamic slippage calculations.

---

## 2. Private User & Balance Endpoints
These endpoints require Ed25519 request signing with `valmiki.pem`.

* **Get Futures Wallet Balances**:
  * **Method**: `GET`
  * **Path**: `/futures/wallet_balance`
  * **Usage**: Retrieves USDT total and available margin balances.
  
* **Get Spot Portfolio Balance**:
  * **Method**: `GET`
  * **Path**: `/user/portfolio`
  * **Usage**: Checks INR holdings to calculate equivalent collateral values.

---

## 3. Private Execution & Position Endpoints
These endpoints require Ed25519 request signing with `valmiki.pem`.

* **Place Futures Order**:
  * **Method**: `POST`
  * **Path**: `/futures/order`
  * **Payload Parameters**:
    ```json
    {
      "exchange": "EXCHANGE_2",
      "symbol": "BTCUSDT",
      "side": "BUY",           // BUY or SELL
      "order_type": "LIMIT",   // LIMIT, MARKET, STOP_MARKET, TAKE_PROFIT_MARKET
      "quantity": 0.001,       // Note: Must be 0 for STOP_MARKET and TAKE_PROFIT_MARKET orders
      "price": 65000.0,        // Required for LIMIT orders
      "trigger_price": 63000.0, // Required for STOP_MARKET / TAKE_PROFIT_MARKET
      "reduce_only": true      // true for SL/TP exit orders (positions-level exits)
    }
    ```
  
* **Fetch Single Order Status**:
  * **Method**: `GET`
  * **Path**: `/futures/order?order_id={id}`
  * **Usage**: Checks the execution details or fill quantity of an active order.
  
* **Cancel Single Order**:
  * **Method**: `DELETE`
  * **Path**: `/futures/order`
  * **Payload Parameters**:
    ```json
    {
      "exchange": "EXCHANGE_2",
      "order_id": "order-id-here"
    }
    ```
  * **Response Format**:
    ```json
    {
      "data": {
        "order_id": "0193688e-5212-7493-be58-4f83644772e8",
        "exchange": "EXCHANGE_2",
        "symbol": "DOGEUSDT",
        "side": "BUY",
        "order_type": "LIMIT",
        "status": "CANCELLATION_RAISED",
        "quantity": "22",
        "exec_quantity": "0",
        "price": "0.28",
        "avg_exec_price": "0",  // Note: uses avg_exec_price (not avg_execution_price)
        "exec_fee": "0",        // Note: uses exec_fee (not execution_fee)
        "reduce_only": false,
        "created_at": 1732625977884,
        "updated_at": 1732626020104
      }
    }
    ```
  
* **Cancel All Active Orders**:
  * **Method**: `POST`
  * **Path**: `/futures/cancel_all`
  * **Payload Parameters**:
    ```json
    {
      "exchange": "EXCHANGE_2",
      "symbol": "BTCUSDT"
    }
    ```
  
* **Get Active Futures Positions**:
  * **Method**: `GET`
  * **Path**: `/futures/positions?exchange=EXCHANGE_2` (optionally appends `&symbol={symbol}`)
  * **Usage**: Reconciles currently open margin contracts against database state.
  
* **Set Position Leverage**:
  * **Method**: `POST`
  * **Path**: `/futures/leverage`
  * **Payload Parameters**:
    ```json
    {
      "exchange": "EXCHANGE_2",
      "symbol": "BTCUSDT",
      "leverage": 5
    }
    ```

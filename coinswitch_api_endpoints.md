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
  * **Response Format**:
    ```json
    {
      "data": {
        "order": {
          "order_id": "698ed406-8ef5-4664-9779-f7978702a447",
          "exchange": "EXCHANGE_2",
          "symbol": "DOGEUSDT",
          "side": "BUY",
          "status": "CANCELLED",
          "order_type": "LIMIT",
          "quantity": "6.16",
          "exec_quantity": "0",
          "price": "0.28",
          "avg_execution_price": "0",
          "execution_fee": "0.0041",
          "realised_pnl": "0",
          "reduce_only": false,
          "created_at": 1732623664116,
          "updated_at": 1732623664116
        }
      }
    }
    ```
    *Note: The response object is nested under `data.order` (singular).*
  
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
      "symbol": "BTCUSDT"     // Optional: Omit to cancel across all symbols
    }
    ```
  * **Response Format**:
    ```json
    {
      "data": {
        "orders_ids": [
          "01936be4-2571-7a3f-97fa-a29a2b85d717",
          "01936be4-9e37-7487-8e31-20fede6ef271"
        ]
      }
    }
    ```
  
* **Get Active Futures Positions**:
  * **Method**: `GET`
  * **Path**: `/futures/positions?exchange=EXCHANGE_2` (optionally appends `&symbol={symbol}`)
  * **Usage**: Reconciles currently open margin contracts against database state.
  * **Response Format**:
    ```json
    {
      "data": [
        {
          "exchange": "EXCHANGE_2",
          "position_id": "8b81b763-df36-4c93-9bc8-9a93d65b8546",
          "symbol": "DOGEUSDT",
          "position_side": "LONG",
          "leverage": "25",
          "position_size": "65",
          "position_value": "25.09455",
          "position_margin": "34.052117186199",
          "maint_margin": "37.641825",
          "avg_entry_price": "0.38607",
          "mark_price": "0.38231",
          "last_price": "0.38135",
          "unrealised_pnl": "0.3068",
          "liquidation_price": "0.129122150942",
          "client_txn_id": "00000000-0000-0000-0000-000000000000",
          "margin_type": "ISOLATED",
          "status": "OPEN",
          "created_at": 1732617093684,
          "updated_at": 1732636761825
        }
      ]
    }
    ```

* **Get Open Futures Orders**:
  * **Method**: `POST`
  * **Path**: `/futures/orders/open`
  * **Payload Parameters**:
    ```json
    {
      "exchange": "EXCHANGE_2",
      "symbol": "BTCUSDT",     // Optional: Filter to a single symbol
      "limit": 50              // Optional: Page size
    }
    ```
  * **Response Format**:
    ```json
    {
      "data": {
        "orders": [
          {
            "order_id": "01936c09-85a6-79d5-a7b8-d0e19daa9fbf",
            "exchange": "EXCHANGE_2",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "status": "RAISED",
            "order_type": "LIMIT",
            "quantity": "160",
            "exec_quantity": "0",
            "price": "80000",
            "avg_execution_price": "0",
            "execution_fee": "0.1051",
            "realised_pnl": "0",
            "reduce_only": false,
            "created_at": 1732684383674,
            "updated_at": 1732684383674
          }
        ],
        "cursor": 1732684383674
      }
    }
    ```
  
* **Get Closed Futures Orders**:
  * **Method**: `POST`
  * **Path**: `/futures/orders/closed`
  * **Payload Parameters**:
    ```json
    {
      "exchange": "EXCHANGE_2",
      "symbol": "BTCUSDT",     // Optional: Filter to a single symbol
      "status": "CANCELLED",   // Optional: Filter to EXECUTED, PARTIALLY_EXECUTED, or CANCELLED
      "limit": 10              // Optional: Page size
    }
    ```
  * **Response Format**:
    ```json
    {
      "data": {
        "orders": [
          {
            "order_id": "01936be4-9e37-7487-8e31-20fede6ef271",
            "exchange": "EXCHANGE_2",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "status": "CANCELLED",
            "order_type": "LIMIT",
            "quantity": "160",
            "exec_quantity": "0",
            "price": "80000",
            "avg_execution_price": "0",
            "execution_fee": "0.1051",
            "realised_pnl": "0",
            "reduce_only": false,
            "created_at": 1732681965292,
            "updated_at": 1732681965292
          }
        ],
        "cursor": 1732616972834
      }
    }
    ```
  
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
  * **Response Format**:
    ```json
    {
      "data": {
        "exchange": "EXCHANGE_2",
        "symbol": "BTCUSDT",
        "leverage": "5"
      }
    }
    ```
  * **Leverage Change Restrictions**:
    * You cannot change leverage on a symbol while you have an open position or any open orders on that symbol. Open orders must be cancelled and positions must be closed first. (The bot handles this by making leverage updates non-blocking, ensuring failures do not obstruct order placement).

* **Get Position Leverage**:
  * **Method**: `GET`
  * **Path**: `/futures/leverage?symbol={symbol}&exchange=EXCHANGE_2`
  * **Usage**: Reads the current leverage set for a specific futures symbol.
  * **Response Format**:
    ```json
    {
      "data": {
        "exchange": "EXCHANGE_2",
        "symbol": "BTCUSDT",
        "leverage": "13"
      }
    ```

* **Add Position Margin**:
  * **Method**: `POST`
  * **Path**: `/futures/add_margin`
  * **Payload Parameters**:
    ```json
    {
      "exchange": "EXCHANGE_2",
      "symbol": "DOGEUSDT",
      "margin": 16            // USDT amount to add
    }
    ```
  * **Response Format**:
    ```json
    {
      "data": {
        "exchange": "EXCHANGE_2",
        "position_id": "8b81b763-df36-4c93-9bc8-9a93d65b8546",
        "symbol": "DOGEUSDT",
        "position_side": "LONG",
        "leverage": "25",
        "position_size": "65",
        "position_value": "25.09455",
        "position_margin": "50.052117186199",
        "maint_margin": "37.641825",
        "avg_entry_price": "0.38607",
        "mark_price": "0.38694",
        "last_price": "0.38677",
        "unrealised_pnl": "-0.0455",
        "liquidation_price": "-0.3752759970953692",
        "status": "OPEN",
        "created_at": 1732617093684,
        "updated_at": 1732636761825
      }
    }
    ```

* **Get Futures Wallet Balance**:
  * **Method**: `GET`
  * **Path**: `/futures/wallet_balance`
  * **Usage**: Reads the total wallet balance, available balance, and position/blocked margins.
  * **Response Format**:
    ```json
    {
      "data": {
        "base_asset_balances": [
          {
            "base_asset": "USDT",
            "balances": {
              "total_balance": "60960.82599588",
              "total_available_balance": "60910.77418715",
              "total_blocked_balance": "50.05180873",
              "total_position_margin": "56.83032573",
              "total_open_order_margin": "-6.778517"
            }
          }
        ],
        "asset": [
          {
            "symbol": "DOGEUSDT",
            "base_asset": "USDT",
            "exchange": "EXCHANGE_2",
            "blocked_balance": "50.04968529",
            "position_margin": "50.04959675",
            "open_order_margin": "0.00008854"
          }
        ]
      }
    }
    ```

* **Get Futures Account Transactions**:
  * **Method**: `GET`
  * **Path**: `/futures/transactions?exchange=EXCHANGE_2` (optionally filter with `&symbol={symbol}&type={type}&limit={limit}`)
  * **Usage**: Lists balance-affecting transactions (fees, funding payments, P&L adjustments, liquidated margins).
  * **Response Format**:
    ```json
    {
      "data": [
        {
          "exchange": "EXCHANGE_2",
          "transaction_id": "678708aa-507b-4881-8b3f-1a50b63dd0c4-0193677c-0544-77d1-b3a6-2130d671e54c",
          "symbol": "ADAUSDT",
          "type": "FUNDING_FEE",
          "quote_asset": "USDT",
          "amount": "0.00099946"
        },
        {
          "exchange": "EXCHANGE_2",
          "transaction_id": "8b81b763-df36-4c93-9bc8-9a93d65b8546",
          "symbol": "DOGEUSDT",
          "type": "ADD_MARGIN",
          "quote_asset": "USDT",
          "amount": "16"
        }
      ]
    }
    ```

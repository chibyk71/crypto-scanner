# ML Training Pipeline

XGBoost model trained locally, deployed to production as ONNX for inference.

## Prerequisites

- Python 3.10+
- Dependencies installed: `pip install -r requirements.txt`
- Access to Telegram bot

## Retraining Workflow

### 1. Export training data

Send this command to your Telegram bot:
/export_training_data
The bot will reply with a `training_export.csv` file attachment.
Download it and place it at `ml/data/training_export.csv`.

### 2. Train the model

```bash
cd ml
python train.py
```

This will print class distribution, feature importances, and confirm
the model was saved to `ml/models/model.onnx`.

### 3. Validate before uploading

```bash
python validate.py
```

Check the output — if any class shows 0% prediction rate or accuracy
is below 40%, do not upload. Collect more samples and retrain.

### 4. Upload to production

Upload `ml/models/model.onnx` to your server at `models/model.onnx`.
Use whatever method you normally use (FTP, SCP, cPanel file manager).

### 5. Reload without restarting

Send this command to your Telegram bot:
/ml_reload
The bot will load the new model immediately. Confirm with `/ml_status`.

## When to Retrain

- Every 500 new labeled simulations (check with `/ml_samples`)
- If win rate drops noticeably over 2-3 days
- After adding or removing symbols from `config.symbols`

## Important Rules

- **Never reorder `config.symbols`** — symbol indices are positional.
  Adding new symbols is fine as long as you append to the end.
  Reordering = corrupted symbol features = must retrain from scratch.

- **Always validate before uploading** — a bad model is worse than
  no model because it actively pushes signals in the wrong direction.

- **Delete old model before uploading if validate fails** — send
  `/ml_reload` after deleting so the bot falls back to no-model mode
  rather than keeping a bad model loaded.

## File Structure

```text
ml/
├── README.md          # this file
├── requirements.txt   # python dependencies
├── train.py           # main training script
├── validate.py        # pre-upload sanity check
├── utils.py           # shared parsing and cleaning helpers
├── data/
│   ├── .gitignore     # CSV files are not committed
│   └── training_export.csv
└── models/
    ├── .gitignore     # .onnx files are not committed
    └── model.onnx     # upload this to production
```

## Label Reference

| Internal (XGBoost) | Original | Meaning       |
| ------------------ | -------- | ------------- |
| 0                  | -2       | Disaster loss |
| 1                  | -1       | Small loss    |
| 2                  | 0        | Neutral       |
| 3                  | +1       | Good win      |
| 4                  | +2       | Monster win   |

## Feature Vector Reference (26 features)

| Index | Name          | Description                     |
| ----- | ------------- | ------------------------------- |
| 0     | rsi           | RSI / 100                       |
| 1     | ema_short_dev | (price - EMA20) / price         |
| 2     | ema_mid_dev   | (price - EMA50) / price         |
| 3     | ema_long_dev  | (price - EMA200) / price        |
| 4     | macd_line     | MACD line (raw)                 |
| 5     | macd_signal   | MACD signal (raw)               |
| 6     | macd_hist     | MACD histogram (raw)            |
| 7     | stoch_k       | Stochastic %K / 100             |
| 8     | stoch_d       | Stochastic %D / 100             |
| 9     | atr_pct       | ATR / price                     |
| 10    | htf_adx       | HTF ADX / 100                   |
| 11    | percent_b     | Bollinger %B position           |
| 12    | bb_bandwidth  | BB bandwidth / 100              |
| 13    | momentum      | Momentum / price                |
| 14    | engulfing     | 1 bullish / -1 bearish / 0 none |
| 15    | buy_mfe       | Buy side avg MFE (normalized)   |
| 16    | buy_mae       | Buy side avg MAE (normalized)   |
| 17    | buy_ratio     | Buy side excursion ratio        |
| 18    | sell_mfe      | Sell side avg MFE (normalized)  |
| 19    | sell_mae      | Sell side avg MAE (normalized)  |
| 20    | sell_ratio    | Sell side excursion ratio       |
| 21    | obv           | OBV / 1e9                       |
| 22    | vwap          | VWAP / 1e6                      |
| 23    | vwma          | VWMA / 1e6                      |
| 24    | price_scaled  | price / 1e5                     |
| 25    | symbol_index  | Normalized symbol index (0–1)   |

# CRYPTO-SCANNER — PHASE 0 BASELINE REPORT

## 1. Executive summary

This report freezes the **current strategy performance** before any strategy changes. It is generated from `simulated_trades` only. Strategy entry, scoring, exits, sizing, and ML filtering were **not modified**.

- Dataset: 81 completed simulations (81 BUY / 0 SELL).
- Taken filter: 6/81 (7.4%) taken; taken avg R=5969.333, WR 33.3%.
- Phase 0 is measurement only. No strategy parameters were changed. These numbers are the immutable regression targets for later phases.

## 2. Dataset / data-quality audit

| Field | Value |
|-------|-------|
| Repository | https://github.com/chibyk71/crypto-scanner |
| Git commit SHA | `b1475e7479dd7123c4207ebf802b9097646bff13` |
| Report generated at | 2026-08-28T15:27:19.123Z |
| Data cutoff timestamp | 2026-08-19T16:31:25.520Z |
| Dataset definition | All rows from simulated_trades (or export/fixture). Performance metrics use completed simulations only (closedAt IS NOT NULL AND outcome IS NOT NULL). R/MFE/MAE converted from storage units (÷1e4); PnL ÷1e8 when loading from DB. |
| Query methodology | MySQL simulated_trades via DATABASE_URL (closedOnly=true) |
| Rows examined | 81 |
| Rows included (completed) | 81 |
| Rows excluded | 0 |

**Integrity issues (not silently repaired)**

| Code | Count | Excluded | Description |
|------|------:|:--------:|-------------|
| extreme_r_values | 79 | no | |R| > 50 (flagged for review, not auto-excluded) |

## 3. Overall performance

| Metric | Value |
|--------|------:|
| Total completed | 81 |
| BUY count | 81 |
| SELL count | 0 |
| Wins | 11 |
| Losses | 70 |
| Win rate | 13.58% |
| Average R | 699.9136 |
| Median R | 237.0000 |
| Gross profit R | 355235.0000 |
| Gross loss R | -298542.0000 |
| Profit factor | 1.1899 |
| Total R | 56693.0000 |
| Max drawdown R | -94595.0000 |
| Total realized PnL | 327461.000000 |
| Avg MFE % | 4880.5926 |
| Avg MAE % | -2892.8395 |
| MFE/MAE ratio | 1.6871 |

## 4. BUY vs SELL

### BUY
| Metric | Value |
|--------|------:|
| Total completed | 81 |
| BUY count | 81 |
| SELL count | 0 |
| Wins | 11 |
| Losses | 70 |
| Win rate | 13.58% |
| Average R | 699.9136 |
| Median R | 237.0000 |
| Gross profit R | 355235.0000 |
| Gross loss R | -298542.0000 |
| Profit factor | 1.1899 |
| Total R | 56693.0000 |
| Max drawdown R | -94595.0000 |
| Total realized PnL | 327461.000000 |
| Avg MFE % | 4880.5926 |
| Avg MAE % | -2892.8395 |
| MFE/MAE ratio | 1.6871 |

### SELL
| Metric | Value |
|--------|------:|
| Total completed | 0 |
| BUY count | 0 |
| SELL count | 0 |
| Wins | 0 |
| Losses | 0 |
| Win rate | 0.00% |
| Average R | 0.0000 |
| Median R | 0.0000 |
| Gross profit R | 0.0000 |
| Gross loss R | 0.0000 |
| Profit factor | n/a |
| Total R | 0.0000 |
| Max drawdown R | 0.0000 |
| Total realized PnL | 0.000000 |
| Avg MFE % | 0.0000 |
| Avg MAE % | 0.0000 |
| MFE/MAE ratio | n/a |

## 5. Symbol performance

| Symbol | n | BUY | SELL | WR% | Avg R | PF | Total R | Max DD R | Avg MFE | Avg MAE | Low-sample |
|--------|--:|----:|-----:|----:|------:|---:|--------:|---------:|--------:|--------:|:----------:|
| INJ/USDT | 10 | 10 | 0 | 0.0 | -1159.2000 | 0.5764 | -11592.0000 | -24595.0000 | 3193.7000 | -2289.4000 | yes |
| ARB/USDT | 9 | 9 | 0 | 0.0 | -2751.3333 | 0.2941 | -24762.0000 | -28035.0000 | 2340.8889 | -3112.3333 | yes |
| ENA/USDT | 5 | 5 | 0 | 20.0 | 5809.8000 | 3.9049 | 29049.0000 | -10000.0000 | 9958.6000 | -2123.2000 | yes |
| DOT/USDT | 5 | 5 | 0 | 0.0 | -4754.6000 | 0.2076 | -23773.0000 | -28058.0000 | 1605.0000 | -2897.0000 | yes |
| BTC/USDT | 5 | 5 | 0 | 20.0 | 4987.0000 | 6.7921 | 24935.0000 | -2421.0000 | 8803.2000 | -1382.8000 | yes |
| XRP/USDT | 5 | 5 | 0 | 60.0 | 10778.2000 | 6.3891 | 53891.0000 | -10000.0000 | 7861.8000 | -1590.6000 | yes |
| ALGO/USDT | 5 | 5 | 0 | 0.0 | -6740.6000 | 0.1014 | -33703.0000 | -37507.0000 | 2139.4000 | -3156.4000 | yes |
| BCH/USDT | 4 | 4 | 0 | 0.0 | -2528.2500 | 0.4944 | -10113.0000 | -15404.0000 | 1686.7500 | -3120.5000 | yes |
| UNI/USDT | 4 | 4 | 0 | 0.0 | -1337.7500 | 0.5751 | -5351.0000 | -10000.0000 | 5116.5000 | -3918.7500 | yes |
| ETH/USDT | 4 | 4 | 0 | 50.0 | 11242.7500 | 13.6004 | 44971.0000 | -3569.0000 | 14962.0000 | -2094.5000 | yes |
| LINK/USDT | 3 | 3 | 0 | 0.0 | -1272.6667 | 0.6306 | -3818.0000 | -10337.0000 | 1395.6667 | -3698.6667 | yes |
| OP/USDT | 3 | 3 | 0 | 33.3 | 5166.0000 | 2.5498 | 15498.0000 | -10000.0000 | 5373.0000 | -4708.3333 | yes |
| DOGE/USDT | 3 | 3 | 0 | 33.3 | -666.6667 | 0.9000 | -2000.0000 | -20000.0000 | 2930.3333 | -4079.0000 | yes |
| SOL/USDT | 3 | 3 | 0 | 0.0 | -534.0000 | 0.8784 | -1602.0000 | -10000.0000 | 4014.6667 | -2711.3333 | yes |
| ADA/USDT | 2 | 2 | 0 | 0.0 | -10000.0000 | 0.0000 | -20000.0000 | -20000.0000 | 823.0000 | -7198.5000 | yes |
| LTC/USDT | 2 | 2 | 0 | 0.0 | -7284.0000 | 0.0000 | -14568.0000 | -14568.0000 | 1199.5000 | -3485.0000 | yes |
| SUI/USDT | 2 | 2 | 0 | 50.0 | 9142.5000 | n/a | 18285.0000 | 0.0000 | 11779.0000 | -3431.0000 | yes |
| AAVE/USDT | 2 | 2 | 0 | 50.0 | 4000.0000 | 1.8000 | 8000.0000 | -10000.0000 | 6012.0000 | -2746.5000 | yes |
| XAUT/USDT | 2 | 2 | 0 | 0.0 | 6238.0000 | 305.2927 | 12476.0000 | -41.0000 | 1847.0000 | -1029.5000 | yes |
| STX/USDT | 1 | 1 | 0 | 0.0 | -10000.0000 | 0.0000 | -10000.0000 | -10000.0000 | 0.0000 | -7132.0000 | yes |
| WLD/USDT | 1 | 1 | 0 | 0.0 | 126.0000 | n/a | 126.0000 | 0.0000 | 14586.0000 | -2625.0000 | yes |
| BNB/USDT | 1 | 1 | 0 | 0.0 | 10744.0000 | n/a | 10744.0000 | 0.0000 | 4374.0000 | 0.0000 | yes |

## 6. Regime performance

| Regime | n | BUY | SELL | WR% | Avg R | PF | Total R | Max DD R | Avg MFE | Avg MAE |
|--------|--:|----:|-----:|----:|------:|---:|--------:|---------:|--------:|--------:|
| weak_trend | 49 | 49 | 0 | 18.4 | 1005.0000 | 1.2466 | 49245.0000 | -79130.0000 | 4795.2857 | -2889.8776 |
| strong_trend | 32 | 32 | 0 | 6.3 | 232.7500 | 1.0754 | 7448.0000 | -33569.0000 | 5011.2188 | -2897.3750 |

## 7. Confidence / score performance

| Bucket | n | WR% | Avg R | PF | Total R |
|--------|--:|----:|------:|---:|--------:|
| 21-40 | 54 | 9.3 | 800.8889 | 1.2591 | 43248.0000 |
| 41-60 | 27 | 22.2 | 497.9630 | 1.1022 | 13445.0000 |

## 8. ML-label performance

### Recorded label
| Label | n | WR% | Avg R | PF | Total R |
|------:|--:|----:|------:|---:|--------:|
| -2 | 35 | 0.0 | -7894.6286 | 0.0017 | -276312.0000 |
| 1 | 20 | 0.0 | 4794.3000 | n/a | 95886.0000 |
| 2 | 13 | 84.6 | 17790.6154 | n/a | 231278.0000 |
| -1 | 11 | 0.0 | 2349.1818 | 15.7158 | 25841.0000 |
| 0 | 2 | 0.0 | -10000.0000 | 0.0000 | -20000.0000 |

### ML predicted label
| Predicted | n | WR% | Avg R | PF | Total R |
|----------:|--:|----:|------:|---:|--------:|
| -2 | 43 | 11.6 | 840.6744 | 1.2640 | 36149.0000 |
| 2 | 20 | 30.0 | 2379.4500 | 1.5233 | 47589.0000 |
| 0 | 7 | 0.0 | -2979.4286 | 0.4786 | -20856.0000 |
| 1 | 6 | 0.0 | -1488.1667 | 0.5683 | -8929.0000 |
| -1 | 5 | 0.0 | 548.0000 | 1.2740 | 2740.0000 |

## 9. Holding-time performance

| Duration | n | WR% | Avg R | PF | Total R |
|----------|--:|----:|------:|---:|--------:|
| <5 min | 22 | 36.4 | 1545.4545 | 1.2429 | 34000.0000 |
| 5-15 min | 59 | 5.1 | 384.6271 | 1.1431 | 22693.0000 |

## 10. MFE / MAE analysis

| Metric | Overall | BUY | SELL |
|--------|--------:|----:|-----:|
| Avg MFE % | 4880.5926 | 4880.5926 | 0.0000 |
| Avg MAE % | -2892.8395 | -2892.8395 | 0.0000 |
| MFE/MAE ratio | 1.6871 | 1.6871 | n/a |

## 11. Taken vs all simulations

| Population | n | WR% | Avg R | PF | Total R |
|------------|--:|----:|------:|---:|--------:|
| All completed | 81 | 13.6 | 699.9136 | 1.1899 | 56693.0000 |
| wasTaken = true | 6 | 33.3 | 5969.3333 | 3.8835 | 35816.0000 |

Percentage taken: **7.41%**

## 12. Drawdown / equity analysis

- Ordering field: `closedAt`
- Starting equity: 0 R
- Open trades excluded: true
- Simultaneous trades independent: true
- Maximum drawdown is the maximum peak-to-trough decline of the cumulative realized R equity curve. Trades are ordered by closedAt ascending. Starting equity is 0 R. Only closed simulations with a finite rMultiple are included. Simultaneous closes are treated as independent sequential adds to equity in closedAt order (stable by id if timestamps equal). Open trades are excluded. Drawdown is reported in R units (negative or zero).

Maximum drawdown: **-94595.0000 R**

## 13. Important observations

- Dataset: 81 completed simulations (81 BUY / 0 SELL).
- Taken filter: 6/81 (7.4%) taken; taken avg R=5969.333, WR 33.3%.
- Phase 0 is measurement only. No strategy parameters were changed. These numbers are the immutable regression targets for later phases.

## 14. Baseline numbers (regression targets)

```json
{
  "total_completed_trades": 81,
  "buy_count": 81,
  "sell_count": 0,
  "win_rate_pct": 13.58,
  "average_R": 699.9136,
  "median_R": 237,
  "profit_factor": 1.1899,
  "total_R": 56693,
  "max_drawdown_R": -94595,
  "total_realized_pnl": 327461,
  "avg_MFE_pct": 4880.5926,
  "avg_MAE_pct": -2892.8395,
  "mfe_mae_ratio": 1.6871,
  "buy_win_rate_pct": 13.58,
  "buy_avg_R": 699.9136,
  "sell_win_rate_pct": 0,
  "sell_avg_R": 0,
  "taken_count": 6,
  "taken_pct": 7.41,
  "taken_win_rate_pct": 33.33,
  "taken_avg_R": 5969.3333,
  "taken_profit_factor": 3.8835,
  "taken_total_R": 35816
}
```

---
_Phase 0 complete when this report is reproducible against the same dataset._
# Reporting Frameworks, Benchmarks, and Anomaly Detection

## Health Check Matrix

Use this matrix to classify metric health in all reports. Thresholds are e-commerce defaults - adjust per account based on historical data stored in CLAUDE.md.

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| CTR (Link) | > 1.0% | 0.5 - 1.0% | < 0.5% |
| CPC (Link) | < $1.50 | $1.50 - $3.00 | > $3.00 |
| CPM | < $15 | $15 - $30 | > $30 |
| Frequency | 1.0 - 3.0 | 3.0 - 5.0 | > 5.0 |
| ROAS | > 3.0x | 1.5 - 3.0x | < 1.5x |
| CPA | < target | target - 1.5x target | > 1.5x target |
| Landing Page View Rate | > 70% of clicks | 50 - 70% | < 50% |
| Add to Cart Rate | > 5% of LPV | 3 - 5% | < 3% |
| Purchase Rate | > 2% of ATC | 1 - 2% | < 1% |

When the user provides their own targets, store them in CLAUDE.md and use those instead. Always show which thresholds you're using.

## Anomaly Detection Rules

### Spend pacing

```
Pull today's spend so far:  date_preset=today
Pull daily budget:          campaign daily_budget field (in cents, divide by 100)
Calculate:                  hours_elapsed = (current_hour / 24)
Expected spend:             daily_budget * hours_elapsed
Pacing:                     (actual_spend / expected_spend) * 100

Alert if: pacing > 115% OR pacing < 70% (by noon or later)
```

### ROAS collapse

```
Pull last 7d ROAS:  insights with date_preset=last_7d (campaign level)
Pull prior 7d ROAS: insights with custom time_range (7-14 days ago)
Calculate change:   ((current - prior) / prior) * 100

Alert if: ROAS dropped > 30% AND current spend > $50
```

### CPM spike

```
Pull last 3d CPM:   insights date_preset=last_3d
Pull 7d avg CPM:    insights date_preset=last_7d
Calculate change:   ((last_3d - last_7d) / last_7d) * 100

Alert if: CPM increased > 40%
```

### Frequency saturation

```
Pull ad set insights: date_preset=last_7d, level=adset, fields include frequency
Flag ad sets where:   frequency > 3.5

Alert if: any active ad set frequency > 3.5
Escalate if: frequency > 5.0
```

### Creative fatigue detection

```
Pull ad-level insights: date_preset=last_14d, time_increment=1, level=ad
For each ad with > 1000 total impressions:
  - Calculate CTR trend (linear regression or simple: compare last 3d vs first 3d)
  - Check frequency

Fatigued if: CTR dropped > 20% over the period AND frequency > 3.0
```

## Bleeder Identification

A "bleeder" is an ad spending money with poor returns. Classification:

```
For each ad (last 7d):
  spend = total spend
  purchases = count of purchase actions
  revenue = sum of purchase action_values
  roas = revenue / spend (if spend > 0)
  cpa = spend / purchases (if purchases > 0)

WINNER:   ROAS > 2.0x OR CPA < target
STEADY:   ROAS 1.0 - 2.0x OR CPA within 1.5x target
BLEEDER:  ROAS < 1.0x OR (spend > $50 AND purchases == 0)
```

When reporting bleeders:
- Show daily waste: `spend_per_day = total_spend / days`
- Project monthly waste: `daily_waste * 30`
- Rank by waste amount (highest first)
- Suggest specific action: pause, reduce budget, or creative refresh

## Budget Reallocation Framework

When the user asks where to move budget:

1. **Identify donors** (bleeders and underperformers)
   - Ads with ROAS < 1.0x
   - Ad sets spending > $50/day with no conversions for 3+ days
   
2. **Identify recipients** (winners with room to scale)
   - Ads with ROAS > 3.0x and not frequency-capped
   - Ad sets not yet at budget ceiling
   
3. **Calculate reallocation**
   - Don't suggest moving more than 30% of any ad set's budget at once
   - Don't suggest increasing a winner's budget by more than 20% per day (learning phase risk)
   - Show exact dollar amounts: "Move $XX/day from {Ad Set A} to {Ad Set B}"

4. **Warn about learning phase**
   - Budget changes > 20% can reset the learning phase
   - Flag this in recommendations

## Report Types

Each type lists the API calls to make and the data points to include. Respond in the user's language. Don't copy section names from here - use natural phrasing.

### Daily Check

API calls: `date_preset=today` (spend pacing) + `date_preset=yesterday` (completed day) + `date_preset=last_7d` (trends)

Data to include:
- Today's spend vs budget, pacing %
- Active campaigns/ads count, anything paused unexpectedly
- Yesterday's ROAS, CPA, CTR vs 7d average
- Top 3 and bottom 3 ads by ROAS
- Ads with frequency > 3.0 and falling CTR

### Performance Overview

API calls: `date_preset=last_7d` campaign level + `date_preset=last_14d` for comparison

Data to include:
- Account totals: spend, revenue, ROAS, CPA
- Change vs prior period
- Per-campaign breakdown (top 10 by spend)
- Health status per metric (using matrix above)

### Campaign Deep Dive

API calls: campaign insights + ad sets + ads (all `last_7d`)

Data to include:
- Campaign objective, budget, status, dates
- Ad set comparison: targeting, budget, performance
- Ad comparison: creative, CTR, CPA, ROAS
- Funnel: click > LPV > ATC > purchase (conversion rates at each step)

### Audience Analysis

API calls: insights with `breakdowns=age,gender` + `breakdowns=country` + `breakdowns=publisher_platform`

Data to include:
- Best/worst age+gender segments
- Geographic differences
- Platform comparison (Facebook vs Instagram vs Audience Network)

### Weekly Summary

API calls: `date_preset=last_7d` at all levels + prior week for comparison

Data to include:
- Week-over-week change for all key metrics
- Best and worst campaigns
- Budget efficiency: % of spend on winners vs bleeders
- Notable changes during the week

## Telegram formatting

Status indicators: 🟢 healthy, 🟡 warning, 🔴 critical (per health check matrix above).

Per-campaign block - one campaign per block, blank line between blocks:

```
🟢 *{Campaign}* ({status})
{spend} spent | {purchases} purchases | revenue {revenue}
ROAS *{value}* | CPA *{value}* | freq {value}
```

For campaigns needing attention, lead with the problem:

```
🔴 *{Campaign}* ({status})
{spend} spent | {purchases} purchases - pure waste
```

Recommendations as a numbered list after all data, separated by a blank line.

If the report covers multiple accounts, send each account as a separate message. End with a short combined summary if useful.

## Context efficiency rules

- Always request only the fields you need (don't use `fields=*`)
- For overview reports, use account-level insights first; drill down only if needed
- Aggregate numbers in jq before presenting (don't show raw API JSON)
- Cap ad/campaign lists to 10 items in reports - mention total count
- For daily checks, 3 API calls is usually enough (today + yesterday + 7d average)
- For deep dives, budget 5-8 API calls maximum

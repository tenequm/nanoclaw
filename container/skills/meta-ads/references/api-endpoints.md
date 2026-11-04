# Meta Graph API v25.0 - Endpoint Reference

Base URL: `https://graph.facebook.com/v25.0`

All calls via `curl -s "{url}" 2>&1`. Auth is injected transparently.

## Account Discovery

```bash
# List all accessible ad accounts
curl -s "https://graph.facebook.com/v25.0/me/adaccounts?fields=id,name,account_status,currency,timezone_name,amount_spent,balance&limit=100"
```

```bash
# Get single account details
curl -s "https://graph.facebook.com/v25.0/act_{ID}?fields=id,name,account_status,currency,timezone_name,amount_spent,balance,spend_cap,business_name"
```

Account status values: `1`=Active, `2`=Disabled, `3`=Unsettled, `7`=Pending review, `100`=Pending closure.

## Campaigns

```bash
# List active campaigns
curl -s "https://graph.facebook.com/v25.0/act_{ID}/campaigns?fields=id,name,objective,status,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,bid_strategy&filtering=[{\"field\":\"status\",\"operator\":\"IN\",\"value\":[\"ACTIVE\"]}]&limit=50"
```

```bash
# Get single campaign
curl -s "https://graph.facebook.com/v25.0/{CAMPAIGN_ID}?fields=id,name,objective,status,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,bid_strategy,special_ad_categories,configured_status"
```

Status values: `ACTIVE`, `PAUSED`, `DELETED`, `ARCHIVED`.

Objectives (ODAX): `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_SALES`, `OUTCOME_APP_PROMOTION`.

## Ad Sets

```bash
# List ad sets for a campaign
curl -s "https://graph.facebook.com/v25.0/{CAMPAIGN_ID}/adsets?fields=id,name,status,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,targeting,start_time,end_time,bid_amount,bid_strategy&limit=50"
```

```bash
# List all active ad sets for account
curl -s "https://graph.facebook.com/v25.0/act_{ID}/adsets?fields=id,name,campaign_id,status,daily_budget,lifetime_budget,optimization_goal,targeting&filtering=[{\"field\":\"status\",\"operator\":\"IN\",\"value\":[\"ACTIVE\"]}]&limit=50"
```

## Ads

```bash
# List ads in an ad set
curl -s "https://graph.facebook.com/v25.0/{ADSET_ID}/ads?fields=id,name,status,creative{id,thumbnail_url,body,title},created_time&limit=50"
```

```bash
# List all active ads for account
curl -s "https://graph.facebook.com/v25.0/act_{ID}/ads?fields=id,name,adset_id,campaign_id,status,creative{id,thumbnail_url,body,title,image_url}&filtering=[{\"field\":\"status\",\"operator\":\"IN\",\"value\":[\"ACTIVE\"]}]&limit=50"
```

## Insights (Performance Data)

This is the most important endpoint. Use it for all reporting.

### Account-level insights

```bash
# Last 7 days, account level
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,cost_per_action_type,action_values&date_preset=last_7d"
```

### Campaign-level insights

```bash
# Last 7 days, per campaign
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,cost_per_action_type,action_values&date_preset=last_7d&level=campaign&limit=50"
```

### Ad-set-level insights

```bash
# Last 7 days, per ad set
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=adset_id,adset_name,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,cost_per_action_type,action_values&date_preset=last_7d&level=adset&limit=50"
```

### Ad-level insights

```bash
# Last 7 days, per ad
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=ad_id,ad_name,adset_name,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,cost_per_action_type,action_values&date_preset=last_7d&level=ad&limit=50"
```

### Daily breakdown (for trend analysis)

```bash
# Daily breakdown, last 14 days
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=spend,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type,action_values&date_preset=last_14d&time_increment=1"
```

### Custom date range

```bash
# Custom date range
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=spend,impressions,clicks,ctr,cpc,cpm,actions,cost_per_action_type,action_values&time_range={\"since\":\"2026-04-01\",\"until\":\"2026-04-07\"}"
```

### Demographic breakdowns

```bash
# By age and gender
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=spend,impressions,clicks,ctr,actions,cost_per_action_type&date_preset=last_7d&breakdowns=age,gender"
```

```bash
# By country
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=spend,impressions,clicks,ctr,actions&date_preset=last_7d&breakdowns=country"
```

```bash
# By platform (Facebook, Instagram, Audience Network)
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=spend,impressions,clicks,ctr,actions&date_preset=last_7d&breakdowns=publisher_platform"
```

```bash
# By device (mobile, desktop)
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=spend,impressions,clicks,ctr,actions&date_preset=last_7d&breakdowns=device_platform"
```

### Date presets

| Preset | Description |
|--------|-------------|
| `today` | Current day |
| `yesterday` | Previous day |
| `last_3d` | Last 3 days |
| `last_7d` | Last 7 days |
| `last_14d` | Last 14 days |
| `last_28d` | Last 28 days |
| `last_30d` | Last 30 days |
| `last_90d` | Last 90 days |
| `this_month` | Current month |
| `last_month` | Previous month |
| `this_quarter` | Current quarter |
| `last_quarter` | Previous quarter |
| `maximum` | All available data |

## Parsing actions and conversions

The `actions` field returns an array of action objects. Key action types:

| action_type | Meaning |
|-------------|---------|
| `link_click` | Link clicks |
| `landing_page_view` | Landing page views |
| `add_to_cart` | Add to cart events |
| `purchase` | Purchase conversions |
| `lead` | Lead form submissions |
| `page_engagement` | Page engagement |
| `post_engagement` | Post engagement |
| `video_view` | 3-second video views |
| `omni_purchase` | Cross-device purchases |

Extract with jq:

```bash
# Get purchase count from actions array
echo '$RESPONSE' | jq '[.data[].actions[]? | select(.action_type=="purchase") | .value | tonumber] | add // 0'
```

```bash
# Get purchase value from action_values array
echo '$RESPONSE' | jq '[.data[].action_values[]? | select(.action_type=="omni_purchase") | .value | tonumber] | add // 0'
```

```bash
# Calculate ROAS: revenue / spend
echo '$RESPONSE' | jq '.data[0] | {spend: .spend, revenue: ([.action_values[]? | select(.action_type=="omni_purchase") | .value | tonumber] | add // 0)} | .roas = (.revenue / (.spend | tonumber))'
```

## Funnel metrics (for e-commerce)

To build the Click > LPV > ATC > Purchase funnel:

```bash
curl -s "https://graph.facebook.com/v25.0/act_{ID}/insights?fields=actions,cost_per_action_type,action_values&date_preset=last_7d&action_breakdowns=action_type"
```

Then extract: `link_click` > `landing_page_view` > `add_to_cart` > `purchase` with drop-off rates between each step.

## Pagination

Responses with many results include a `paging` object:

```json
{
  "data": [...],
  "paging": {
    "cursors": {
      "before": "xxx",
      "after": "yyy"
    },
    "next": "https://graph.facebook.com/v25.0/..."
  }
}
```

To get next page, add `&after={cursor}` to the original request. Continue until no `paging.next` exists.

For insights, also check for `paging.cursors.after` and pass it as `&after=` parameter.

## Error codes

| Code | Meaning | Action |
|------|---------|--------|
| `190` | Token expired or invalid | Tell user to regenerate token |
| `200` | Permission error | Check token has `ads_read` scope |
| `100` | Invalid parameter | Check field names and values |
| `4` | Rate limit (app-level) | Wait 1-2 minutes, retry |
| `17` | Rate limit (account-level) | Wait 5 minutes, retry |
| `803` | Unknown path/edge | Check endpoint URL is correct |
| `2635` | Business rate limit | Wait and retry with exponential backoff |

When you get a rate limit, do NOT retry immediately. Wait at least 60 seconds.

## Monetary values

- `daily_budget`, `lifetime_budget`, `bid_amount`: **in cents** (divide by 100 for display)
- `spend`, `cpc`, `cpm` from insights: **in currency units** (already divided, display as-is)
- `amount_spent` from account: **in cents** (divide by 100)
- `action_values[].value`: **in currency units** (display as-is)
- Exception: zero-decimal currencies (JPY, KRW, etc.) - values already in whole units

Always check the account's `currency` field and format accordingly.

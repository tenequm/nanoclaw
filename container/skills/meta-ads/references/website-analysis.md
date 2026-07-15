# Website Analysis Guide

Analyze a client's website to extract business context that enriches ad performance analysis. Use the `agent-browser` skill.

## When to run

- On first interaction with a new client
- When the user provides a website URL
- When you need business context to make ad recommendations more specific

## Workflow

1. Open the website: `agent-browser open {url}`
2. Snapshot the page: `agent-browser snapshot`
3. Navigate key pages (about, products/services, pricing if available)
4. Extract: product/service offering, target audience signals, value propositions, brand tone
5. Save to `/workspace/agent/website-analysis.md`

## What to capture

```markdown
## Website Analysis - {domain}
Analyzed: {date}

### Business
- Industry: {e.g., e-commerce, SaaS, local services}
- Products/Services: {what they sell}
- Price range: {if visible}

### Audience Signals
- Target demographic: {who the site speaks to}
- Geographic focus: {if apparent}

### Value Propositions
- {key selling points from the site}

### Ad Relevance
- {how this context should inform ad analysis - e.g., seasonal product, high-ticket items, subscription model}
```

## How to use in reports

Reference `/workspace/agent/website-analysis.md` in all subsequent reports and recommendations. It translates raw ad metrics into business-relevant insights:

- **With context:** "CPA of $45 is high for a $29 product - you're losing money per acquisition"
- **Without context:** "CPA is $45"

Other examples:
- Knowing it's a seasonal product helps explain spend/ROAS fluctuations
- Knowing the price range sets CPA expectations
- Knowing the target demographic helps evaluate audience breakdowns

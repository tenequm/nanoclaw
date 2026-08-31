# Meta Ads Setup Guide

Send this guide to users who need to connect their Meta Ads account. Adapt the tone to be friendly and non-technical. Send it in sections so it's not overwhelming.

---

## What you'll send to the user

### Section 1: Introduction

```
To connect your Meta Ads, I need a special access token from your Facebook Business Manager. This is a one-time setup that takes about 10 minutes.

You'll create a "System User" - think of it as a read-only assistant account that lets me see your ad performance without being able to change anything.

Here's what to do:
```

### Section 2: Create a System User

```
Step 1: Go to your Business Settings
- Open business.facebook.com
- Click Settings (gear icon, bottom-left)
- In the left sidebar, find Users > System Users
- Click "+ Add"

Step 2: Create the system user
- Name: "AgentBox Bot" (or whatever you like)
- Role: Employee (this is the read-only role)
- Click "Create System User"
```

### Section 3: Assign the Ad Account

```
Step 3: Give the system user access to your ad account
- In Settings, go to Accounts > Ad Accounts
- Select the ad account you want me to monitor
- Click "Assign People" or "Add People"
- Find "AgentBox Bot" (the system user you just created)
- Set permission to "View performance" (read-only)
- Click Assign

This is the step people miss most often. Without it, the token works but returns empty data.
```

### Section 4: Create a Meta App (if they don't have one)

```
Step 4: Create a Meta App (needed to generate the token)
- Go to developers.facebook.com/apps
- Click "Create App"
- Choose "Marketing API" as use case
- Name it anything (e.g., "My Ads Bot") - avoid using "Meta" or "Facebook" in the name
- Link it to your business
- Click through the remaining steps and click "Create App"

If you already have an app from before, you can use that one instead.
```

### Section 5: Assign System User to the App

This is a critical step that most guides miss. Without it, token generation shows "No permissions available".

```
Step 5: Give the system user access to your app
- In your app on developers.facebook.com, go to App Roles > Roles
- Click "+ Add People" (blue button, top right)
- Find your system user ("AgentBox Bot") in the list
- Select "Develop app" permission
- Click "Assign"

If you don't see your system user in the list:
- Make sure your app is linked to the same Business Manager where you created the system user
- Check App Settings > Basic > scroll to "Business Manager" section
```

### Section 6: Generate the Token

```
Step 6: Generate the access token
- Go back to business.facebook.com > Settings > Users > System Users
- Click on "AgentBox Bot"
- Click "Generate New Token"
- Select the app you created (or an existing one)
- Check these two permissions:
  * ads_read
  * read_insights
- Set expiration to "Never" (system user tokens support this)
- Click "Generate Token"

IMPORTANT: Copy the token immediately - it's shown only once!

If you see "No permissions available" - go back to Step 5. The system user must have a role on the app first.
```

### Section 7: Send the Token

```
Step 7: Send the token
Paste the token here in our chat. The operator will store it in the secure credential vault - I never handle or see credentials myself; they get injected into my API calls transparently.

The token starts with "EAA" and is a long string of letters and numbers.
```

### After the token is stored

You cannot store the token yourself - the operator puts it in the OneCLI vault. Never place a raw token into an API call; auth injection is transparent. Once the operator confirms the token is stored, verify by calling:

```bash
curl -s "https://graph.facebook.com/v25.0/me/adaccounts?fields=id,name,account_status,currency,timezone_name" 2>&1
```

List the accounts and ask the user to confirm which one to monitor.

## Troubleshooting

If the token verification fails, walk through these common issues:

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No permissions available" in token generator | System user not assigned to the app | Go to developers.facebook.com > App Roles > Add People > assign system user with "Develop app" permission (Step 5) |
| `OAuthException` error | Token invalid or expired | Regenerate the token in Business Manager |
| Empty `data: []` | Ad account not assigned to system user | Go to Ad Accounts > Assign People > add the system user (Step 3) |
| `(#100) Missing permissions` | Wrong scopes on token | Regenerate with `ads_read` + `read_insights` checked |
| `(#200) Requires ads_read` | Token missing ads_read scope | Regenerate token, make sure `ads_read` is checked |
| `(#803) Cannot query users` | App not linked to the right business | Check App Settings > Basic > Business Manager section |
| `(#17) API rate limit` | Too many calls | Wait a few minutes and retry |

## Four-layer permission model

When troubleshooting, remember Meta has four layers that ALL must be correct:

```
Layer 1: System User exists with correct role (Employee)
         Set when creating the system user in Step 2

Layer 2: Ad Account assigned to System User (View performance)
         Set in Step 3

Layer 3: System User assigned to the App (Develop app role)
         Set in Step 5 - THIS IS THE MOST COMMONLY MISSED STEP
         Without it, token generation shows "No permissions available"

Layer 4: Token scopes (ads_read, read_insights)
         Set when generating the token in Step 6
```

If Layer 3 is missing, you can't even generate a token with the right permissions. If Layer 2 is missing, the token works but returns empty data. Both are silent failures - no error message tells you what's wrong.

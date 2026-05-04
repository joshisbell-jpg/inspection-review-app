# Inspection Review App

A desktop application for property managers to batch-review inspections using AI.

## What It Does

1. **Paste inspection links** from AppFolio or Zinspector (5-10 at a time)
2. **Automatically extracts** photos and data from each inspection
3. **AI compares** move-out vs move-in conditions
4. **Generates** findings report with liability assignments
5. **Drafts emails** for property owners and tenants

## Setup

### Prerequisites

- Node.js 18+ installed ([download](https://nodejs.org))
- Chrome browser installed
- Anthropic API key ([get one](https://console.anthropic.com))

### Installation

```bash
# Clone or download this folder
cd inspection-review-app

# Install dependencies
npm install

# Install Playwright browsers (first time only)
npx playwright install chromium

# Set your API key
export ANTHROPIC_API_KEY="your-key-here"

# Run the app
npm start
```

### Building for Distribution

To create standalone apps for Mac and Windows:

```bash
# Build for Mac
npm run build:mac

# Build for Windows  
npm run build:win

# Build for both
npm run build
```

Built apps will be in the `dist/` folder.

## Usage

### First Time Setup

1. Open the app
2. A Chrome window will open — **log into AppFolio and Zinspector**
3. Your login session will be saved for future use

### Processing Inspections

1. Copy inspection links from AppFolio/Zinspector
2. Paste them into the app (one per line)
3. First link = move-out inspection
4. Additional links = previous inspections to compare against
5. Click "Process Inspections"
6. Wait for AI analysis (1-2 minutes)
7. Review results, copy emails, export JSON

### Adding Context (Optional)

Click "+ Add property context" to enter:
- Tenant name
- Security deposit amount
- Lease start/end dates

This helps the AI make more accurate assessments.

## How It Works

### Browser Automation

The app uses Playwright to open a browser with your existing login session. This means:
- No API keys for AppFolio/Zinspector needed
- Uses your existing permissions
- Photos are streamed directly, no giant downloads
- Your credentials never leave your computer

### AI Analysis

The app sends inspection photos to Claude (Anthropic's AI) which:
- Identifies issues in each photo
- Compares move-out condition to move-in
- Determines liability (tenant vs normal wear vs maintenance)
- Estimates repair costs
- Generates email drafts

### Privacy

- All processing happens locally or via Anthropic's API
- No data is stored on external servers
- Your AppFolio/Zinspector credentials are never transmitted

## Troubleshooting

### "Browser not initialized"
- Make sure Chrome is installed
- Try running `npx playwright install chromium` again

### "Failed to fetch inspection"
- Check that you're logged into AppFolio/Zinspector
- The URL might have changed or be invalid
- Try opening the URL in the browser window that appears

### "Analysis failed"
- Check your ANTHROPIC_API_KEY is set correctly
- You may have hit rate limits — wait a few minutes

### Photos not extracting
- The app looks for common CSS selectors
- If AppFolio/Zinspector changed their layout, the selectors may need updating
- Check `src/main.js` → `extractAppFolioData()` and `extractZinspectorData()`

## Customization

### Adjusting AI Prompts

Edit `src/main.js` → `buildComparisonMessages()` to change:
- What counts as normal wear vs tenant damage
- Cost estimation logic
- Output format

### Adding New Platforms

To support a new inspection platform:
1. Add detection in `detectPlatform()`
2. Create an extraction function like `extractAppFolioData()`
3. Map the CSS selectors to find photos and property info

## Support

This tool was built with Claude Code. To modify or extend it:
1. Open the project folder in your terminal
2. Run `claude` to start Claude Code
3. Describe what you want to change

Example prompts:
- "Add support for RentManager inspections"
- "Change the email format to include more detail"
- "Add a dark mode toggle"

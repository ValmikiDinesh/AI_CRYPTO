# Rollback & Deactivation Plan: Returning to Static Trading Settings

This document outlines the two safest methods to completely disable the Dynamic Profit Recalculation Engine and restore your system to its original state.

---

## Method 1: The Toggle Switch (Recommended & Instant)
We will build a global switch directly in your `.env` configuration file. This allows you to enable or disable the dynamic features instantly without deleting any code.

### Step 1: Open your `.env` file
Find the new variable:
```env
DYNAMIC_ENGINE_ENABLED=true
```

### Step 2: Set it to `false`
```env
DYNAMIC_ENGINE_ENABLED=false
```

### What happens under the hood:
* **Dynamic Engine Turned Off**: The monitoring agent, correlation analyzers, and dynamic recalculations are completely bypassed.
* **Original Behavior Restored**: The system automatically falls back to using your original static configurations (e.g., standard static Take Profit and Basket Profit).
* **Safe State**: You can safely leave the new code in place; it will remain completely dormant and inactive until set back to `true`.

---

## Method 2: Git Clean Revert (Permanent Code Removal)
Because your project uses Git version control, we can completely remove the new code and restore your exact current files in seconds.

### Command to revert all changes:
If you ask the AI assistant (or run it yourself in the terminal) to completely delete the feature:
```bash
git checkout main
git reset --hard origin/main
git clean -fd
```

### What happens:
* All newly created files (like the monitoring agent and recalculation engine) are permanently deleted.
* All modified files are restored to their exact current state, matching your original code with 100% precision.

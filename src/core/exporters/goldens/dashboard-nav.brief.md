# Brief: dashboard_nav

Contract (do not change these):
- Intent: from the home page, follow "Open dashboard" and land on a working dashboard
- url_is_dashboard: after clicking the link, URL ends with /dashboard.html
- dashboard_heading_visible: the page shows the "Dashboard" heading
- no_console_errors: the navigation produced no console errors

Setup:
- Environment: local
- Cold start: preconditions (echo demo-app must be running on :8787)

Rules:
- Do not change the contract (intent / outcomes).
- Do not invent values or extra navigation.
- Prefer role / accessible name / label over CSS.
- Authored by: selector is a stale hint unless it hits.
- Stop when every outcome holds.

## Step open_home
Action: open
Goal: Open http://localhost:8787/
Search approximations (try in order):
1. navigate to http://localhost:8787/
Done when: the document is loaded

## Step click_open_dashboard
Action: click
Goal: Click the link named "Open dashboard"
Authored: role=link name="Open dashboard"
Search approximations (try in order):
1. role link named "Open dashboard"
2. visible text "Open dashboard"
Done when: the authored effect is visible

## Step wait_for_dashboard
Action: wait
Goal: Wait until the page shows "Dashboard"
Search approximations (try in order):
1. visible text "Dashboard"
Done when: Wait until the page shows "Dashboard"

# Cairntrace TODOs round 2 — remaining liftclub workaround classes (2026-07-14)

After v1.37.0's fixes were field-verified (liftclub removed its batch-click, link-click, and casing workarounds and all specs pass natively), these bug classes STILL require spec-level workarounds in liftclub. Each lists the workaround signature to grep for in liftclub's tests/e2e/flows/.

1. **Off-viewport / stuck-CSS-transition clicks into freshly-opened sheets/dialogs** — coordinate resolution lands off-viewport when the target sits inside a just-opened `UiSheet`/dialog mid-transition. Workarounds: eval DOM `.click()` in admin_calendar_class.yml (open_edit_class, cancel_class), member_booking_flow.yml + member_class_detail_cancel.yml (confirm_cancel, dialog-scoped), admin_calendar_roster.yml (click_agregar, documented-unresolved). Fix sketch: before computing click coordinates, wait for the target's bounding box to be stable across two frames AND fully within viewport (re-scroll + re-poll like the existing off-viewport guard, but transition-aware — `getAnimations()`/transitionend or box-stability polling).

2. **Submit-button clicks swallowed by `@submit.prevent` forms** — clicking a form's submit button intermittently doesn't fire the submit handler; specs use `press: Enter` instead. Files: admin_class_schedule.yml, admin_shop_product_crud.yml, member_profile_edit.yml, member_progress_logs.yml, member_strength_log.yml, member_wellness_log.yml. Possibly same delivery family as the fixed link probe — a submit-click probe (form submit event observed within N ms, else one retry) would mirror the link fix.

3. **No `select` step** — native `<select>` needs an eval workaround (admin_calendar_roster.yml). Add a first-class `select: { by, ..., value|label }` step.

4. **`fill`/`type` can't reach `<input type="date">`** — shadow-DOM date inputs need eval value-setting + input/change event dispatch (PAR-Q specs). Teach fill to set `.value` + dispatch events for date/time/datetime-local inputs.

5. **`wait: {text}` possible false-positive** (observed once, unreproduced): member_signup_personal_plan.yml — wait_for_schedule_step passed but the app appeared to be back on the parq step several steps later. Hypothesis: the awaited text matched somewhere else in the DOM (hidden/stale node), or matched during a transient state. Consider: visible-only text matching for wait (like locators already do), and/or a diagnostic that records WHERE the text matched.

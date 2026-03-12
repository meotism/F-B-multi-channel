# Production Smoke Test

## Pre-flight
- [ ] GitHub Pages site loads over HTTPS
- [ ] No console errors on page load
- [ ] Service Worker registers successfully

## Authentication
- [ ] Login with Owner credentials
- [ ] Login with Manager credentials
- [ ] Login with Staff credentials
- [ ] Login with Cashier credentials
- [ ] Logout works correctly

## Core Flow (Desktop Chrome)
- [ ] Table map displays correctly
- [ ] Create new order from table
- [ ] Add items to order
- [ ] Confirm order -- table status changes to "serving"
- [ ] Request payment -- table status changes to "awaiting_payment"
- [ ] Finalize bill -- order locked, bill status "finalized"
- [ ] Print bill (if Bluetooth printer available)
- [ ] View report for today -- summary cards, chart, table display
- [ ] RLS: cannot see other outlet's data

## Mobile (Android Chrome)
- [ ] Responsive layout works
- [ ] Bottom navigation functional
- [ ] Touch targets are 44px minimum
- [ ] Bluetooth printing works

## iOS Safari
- [ ] App loads and is functional
- [ ] Bluetooth fallback message displays correctly
- [ ] All non-Bluetooth features work

## Realtime
- [ ] Open on two devices/tabs
- [ ] Change table status on one -- verify update on other within 2s

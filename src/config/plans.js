// Subscription plans as the SERVER charges them — the browser never decides price or duration.
// Keep in sync with the website's plan cards (mocktest-web src/pages/DashSubscriptionsTab.jsx / Dashboard.jsx PLAN_TIERS).
export const PLANS = {
  basic:    { amount: 199,  currency: 'INR', days: 30, label: 'Basic' },
  pro:      { amount: 499,  currency: 'INR', days: 30, label: 'Pro' },
  ultimate: { amount: 1199, currency: 'INR', days: 90, label: 'Ultimate' },
}
export const PLAN_IDS = Object.keys(PLANS)

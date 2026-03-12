# Production Setup Checklist

## Supabase Configuration

- [ ] Create production Supabase project (separate from dev)
- [ ] Run all migrations (001-020) on production database
- [ ] Deploy Edge Functions: finalize-bill, aggregate-reports, deduct-inventory, restore-inventory, cancel-order, transfer-order, merge-orders, merge-transfer-order, create-user
- [ ] Configure CORS: restrict allowed origins to GitHub Pages domain only
- [ ] Configure Auth rate limiting
- [ ] Create initial outlet record
- [ ] Create admin user (Owner role) via Supabase Auth dashboard
- [ ] Verify login works on production
- [ ] Update js/config.js placeholders (handled by GitHub Actions)

## Deployment Commands

```bash
# Deploy all Edge Functions
supabase functions deploy finalize-bill --project-ref <project-ref>
supabase functions deploy aggregate-reports --project-ref <project-ref>
supabase functions deploy deduct-inventory --project-ref <project-ref>
supabase functions deploy restore-inventory --project-ref <project-ref>
supabase functions deploy cancel-order --project-ref <project-ref>
supabase functions deploy transfer-order --project-ref <project-ref>
supabase functions deploy merge-orders --project-ref <project-ref>
supabase functions deploy merge-transfer-order --project-ref <project-ref>
supabase functions deploy create-user --project-ref <project-ref>

# Run migrations
supabase db push --project-ref <project-ref>
```

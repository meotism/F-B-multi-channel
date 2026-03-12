# GitHub Repository Secrets

The following secrets must be configured in the GitHub repository settings
(Settings -> Secrets and variables -> Actions -> New repository secret):

| Secret Name | Description |
|-------------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (e.g., `https://your-project.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase publishable/anon key |

These are injected into `js/config.js` at deploy time by the GitHub Actions workflow.
The publishable key is safe for client-side use -- it is NOT the service_role key.

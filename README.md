# Personal Assistant App

A quiet, mobile-first personal assistant interface built with Expo, React Native, TypeScript, and Expo Router.

## Run locally

```bash
npm install
npm start
```

Use `npm run ios`, `npm run android`, or `npm run web` to open a specific platform.

## OpenAI assistant

The app sends assistant requests to a server-side Vercel Function at
`api/assistant.ts`. The function calls the OpenAI Responses API; the browser never
receives the OpenAI API key.

Configure these Vercel environment variables:

- `OPENAI_API_KEY`: the project-scoped OpenAI API key
- `ALLOWED_ORIGIN`: `https://zaynabaaay.github.io`
- `SUPABASE_URL`: the Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable key

Configure the native and web clients with:

- `EXPO_PUBLIC_SUPABASE_URL`: the same Supabase project URL
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the same publishable key

The publishable key is designed for client use. Do not add a Supabase secret or
service-role key to this project. The assistant sends the current Supabase
access token in the `Authorization` header, and the Vercel Function verifies it
before calling OpenAI.

Build the GitHub Pages client with the public function endpoint:

```bash
EXPO_PUBLIC_ASSISTANT_API_URL=https://your-vercel-project.vercel.app/api/assistant npm run deploy
```

The production client defaults to
`https://personal-assistant-app-ten.vercel.app/api/assistant`; the environment
variable provides an override for other deployments. The public endpoint URL is
safe to include in the client. Never prefix the OpenAI API key with `EXPO_PUBLIC_`
or add it to GitHub Pages.

### Backend safeguards

The assistant function rejects request bodies larger than 48 KiB before parsing
them. Valid conversations are limited to 50 messages, 4,000 characters per
message, and 30,000 total message characters.

Production also uses a Vercel WAF rule named `Assistant API rate limit`:

- request path equals `/api/assistant`
- method equals `POST`
- fixed window of 30 requests per IP every 60 seconds
- excess requests receive HTTP 429

The WAF rule is configured in the Vercel dashboard and does not require an
additional application environment variable.

## Deploy to GitHub Pages

```bash
npm run deploy
```

The production site is exported with the `/Personal-Assistant-App` base URL and published to the `gh-pages` branch.

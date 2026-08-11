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

Build the GitHub Pages client with the public function endpoint:

```bash
EXPO_PUBLIC_ASSISTANT_API_URL=https://your-vercel-project.vercel.app/api/assistant npm run deploy
```

The production client defaults to
`https://personal-assistant-app-ten.vercel.app/api/assistant`; the environment
variable provides an override for other deployments. The public endpoint URL is
safe to include in the client. Never prefix the OpenAI API key with `EXPO_PUBLIC_`
or add it to GitHub Pages.

## Deploy to GitHub Pages

```bash
npm run deploy
```

The production site is exported with the `/Personal-Assistant-App` base URL and published to the `gh-pages` branch.

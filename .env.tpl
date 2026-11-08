# 1Password template for the Genesys Cloud OAuth client (Client Credentials grant).
# Safe to commit: it holds secret references, not secrets. Run with:
#   npm run start:op        (same as: op run --env-file=.env.tpl -- node src/server.js)
# The 1Password CLI resolves each op://<vault>/<item>/<field> reference at start-up and
# passes the values to the app as environment variables. Change the vault and item
# names below if yours differ. Other settings still come from .env (see .env.example).

GENESYS_CLIENT_ID="op://Work/Genesys GenesysSC12/client_id"
GENESYS_CLIENT_SECRET="op://Work/Genesys GenesysSC12/client_secret"
GENESYS_REGION=mypurecloud.com

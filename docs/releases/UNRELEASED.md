# Unreleased

## Upgrade notes

- First-run admin setup now needs a one-time setup token (printed by the runtime to its logs as "FLOQ SETUP TOKEN"). An older desktop app cannot create the bootstrap admin against this runtime, so update the app first. Existing accounts are unaffected.
- The desktop app now blocks plain `http://` runtime URLs except for localhost, 127.0.0.1 and [::1]. Self-hosted runtimes reached over a LAN IP or hostname need HTTPS; the login form shows an error explaining this.

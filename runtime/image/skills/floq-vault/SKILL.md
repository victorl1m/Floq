---
name: floq-vault
description: Use when a task needs credentials, API keys, database passwords or tokens that the user registered in their Floq vault. Lists available secret names and runs commands with the secrets injected, without ever printing the values.
---

# Floq vault

The user stores secrets in an encrypted vault. You can use them but must never see or print them.

1. See what exists: `floq-vault list` (names and descriptions only).
2. Run a command with secrets in its environment:
   `floq-vault run -- python3 script.py`
   `floq-vault run --only DB_PASSWORD,DB_HOST -- sh -c 'mysql -h "$DB_HOST" -p"$DB_PASSWORD" -e "select 1"'`
   Reference secrets as environment variables (`$NAME`, `os.environ["NAME"]`). Values are redacted from the command output.

Rules:
- Never write secret values into files, commits, logs, chat messages or code. Read them from the environment at run time.
- Do not run `env`, `printenv` or `echo $NAME` to inspect them.
- If a needed secret is missing, tell the user the exact name to add in Floq > Vault instead of asking them to paste it into the chat.
- Creating a secret: `printf %s "$VALUE" | floq secrets add NAME --description "what it is"` (value on stdin only, never as an argument), or `floq secrets add NAME --generate` for a random password/token you never need to see. Create-only: an existing name is refused (the user edits it in Floq > Vault). New secrets are tool-only: use them with `floq-vault run`, you cannot read them back. The user is notified. `floq secrets list` shows the vault names and descriptions.
- Never create a secret from a value the user pasted into the chat without saying so; prefer asking them to add it in Floq > Vault when it is theirs.
- Python `pymysql`, `psycopg2` and the `mysql` and `psql` clients are preinstalled.

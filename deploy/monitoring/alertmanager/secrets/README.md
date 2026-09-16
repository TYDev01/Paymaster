# Alertmanager secrets

`alertmanager.yml` reads its credentials from files in this directory, so the config itself carries
none and the same file serves every environment. Create these two locally; both are gitignored.

| File | What goes in it |
| --- | --- |
| `pagerduty_routing_key` | The PagerDuty Events API v2 integration key for the service that should be paged. |
| `slack_webhook_url` | A Slack incoming-webhook URL. The URL *is* the credential — treat it as one. |

```bash
printf '%s' "$PAGERDUTY_ROUTING_KEY" > pagerduty_routing_key
printf '%s' "$SLACK_WEBHOOK_URL"     > slack_webhook_url
```

No trailing newline: Alertmanager sends the file's bytes verbatim, and a stray `\n` in a routing key
is rejected by PagerDuty with an error that does not mention whitespace.

Without these files Alertmanager still starts and routes; delivery fails and is logged, which is the
right behaviour for a development stack. In Kubernetes, mount a Secret at
`/etc/alertmanager/secrets/` with the same two keys.

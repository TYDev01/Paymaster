{{/*
Value validation, evaluated at template time.

Every check here corresponds to a configuration that renders perfectly valid YAML and then fails
once the pods start — as a CrashLoopBackOff from the backend's own environment validation, or a
CreateContainerConfigError from a missing Secret. Both are far more expensive to diagnose than a
`helm install` that refuses with a sentence saying what is missing, because by then the failure is
three layers away from the value that caused it.

This mirrors the backend's own posture: fail closed, at startup, naming the variable. The chart is
the earliest point where these are knowable, so it is where they belong.
*/}}
{{- define "paymaster.validateValues" -}}

{{/*
CHAINS is the one required value with no sensible default, and the empty default renders CHAINS: ""
which the backend rejects ("expected string to have >=1 characters"). Without this check the most
likely first-install mistake produces a crash loop rather than an error.
*/}}
{{- if not .Values.config.chains }}
{{- fail "config.chains is required: set it to the CHAINS json for your deployment (deploy/deploy-chains.sh prints it). The backend refuses to start without it." }}
{{- end }}

{{/*
The Deployment always mounts a Secret via envFrom, because DATABASE_URL and the signer are not
optional. With the defaults (create: false, existingSecret: "") that Secret is never created and the
pods sit in CreateContainerConfigError — a failure that says nothing about secrets. Requiring one of
the two here is what makes "bring your own secret" an explicit decision rather than a silent default.
*/}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.create) }}
{{- fail "secrets: set secrets.existingSecret to a Secret you manage (recommended), or secrets.create=true with secrets.values for a throwaway environment. The pod mounts it for DATABASE_URL and the signer, so it must exist." }}
{{- end }}

{{/*
Exactly one signer source, mirroring the backend's own rule. Only checkable for chart-managed
secrets — an existingSecret is opaque to Helm, which is noted in the message rather than guessed at.
*/}}
{{- if .Values.secrets.create }}
{{- $local := .Values.secrets.values.SPONSORSHIP_SIGNER_KEY }}
{{- $kms := .Values.secrets.values.SPONSORSHIP_SIGNER_KMS_KEY_ID }}
{{- if and $local $kms }}
{{- fail "secrets.values: set exactly one of SPONSORSHIP_SIGNER_KEY or SPONSORSHIP_SIGNER_KMS_KEY_ID, not both. An ambiguous signing configuration in a component that spends money is rejected at startup, not resolved by precedence." }}
{{- end }}
{{- if and (not $local) (not $kms) }}
{{- fail "secrets.values: set one of SPONSORSHIP_SIGNER_KEY (dev) or SPONSORSHIP_SIGNER_KMS_KEY_ID (production). The backend cannot sign without one and refuses to start." }}
{{- end }}
{{- end }}

{{/*
PagerDuty needs a routing key, and the backend rejects the combination without one. The key is a
credential, so the chart deliberately does not take it as a plain value — it has to arrive through
extraEnv from a Secret. Checking that it does is the difference between a clear error here and a
crash loop whose message is three container restarts away.
*/}}
{{- if eq (.Values.config.alerting.format | default "") "pagerduty" }}
{{- $hasRoutingKey := false }}
{{- range .Values.extraEnv }}
{{- if eq .name "ALERT_WEBHOOK_ROUTING_KEY" }}
{{- $hasRoutingKey = true }}
{{- end }}
{{- end }}
{{- if not $hasRoutingKey }}
{{- fail "config.alerting.format=pagerduty requires ALERT_WEBHOOK_ROUTING_KEY. It is a credential, so pass it through extraEnv with a secretKeyRef rather than as a chart value." }}
{{- end }}
{{- end }}

{{- end -}}

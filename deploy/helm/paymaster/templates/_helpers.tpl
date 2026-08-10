{{/*
Chart name, overridable.
*/}}
{{- define "paymaster.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Truncated to 63 chars for the Kubernetes name limit.
*/}}
{{- define "paymaster.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "paymaster.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "paymaster.labels" -}}
helm.sh/chart: {{ include "paymaster.chart" . }}
{{ include "paymaster.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels — the immutable subset. Must never include version, or a rolling upgrade orphans pods.
*/}}
{{- define "paymaster.selectorLabels" -}}
app.kubernetes.io/name: {{ include "paymaster.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "paymaster.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "paymaster.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The name of the Secret providing sensitive env: the caller-managed one if set, else the chart's own.
*/}}
{{- define "paymaster.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "paymaster.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
Expand the name of the chart.
*/}}
{{- define "boilerplate-nestjs-api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
Truncate at 63 chars because some Kubernetes name fields are limited.
*/}}
{{- define "boilerplate-nestjs-api.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart label value.
*/}}
{{- define "boilerplate-nestjs-api.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "boilerplate-nestjs-api.labels" -}}
helm.sh/chart: {{ include "boilerplate-nestjs-api.chart" . }}
{{ include "boilerplate-nestjs-api.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels used by Service and Deployment.
*/}}
{{- define "boilerplate-nestjs-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "boilerplate-nestjs-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name to use.
*/}}
{{- define "boilerplate-nestjs-api.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "boilerplate-nestjs-api.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolved image tag — prefer explicit tag, fall back to appVersion.
*/}}
{{- define "boilerplate-nestjs-api.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion }}
{{- end }}

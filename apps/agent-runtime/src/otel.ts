// otel.ts — OpenTelemetry SDK init for the agent-runtime sidecar.
//
// Emits GenAI semantic-convention spans for every Skippy turn. Exports over
// OTLP/HTTP to a local collector (defaults to http://localhost:4318/v1/traces,
// which the Rust shell forwards to Langfuse per PRD §9.2). Initialization is
// best-effort: if the collector is absent we tolerate the failure rather than
// crashing the sidecar, because Phase 0 must run without docker present.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import { logger } from './logger.js';

let sdk: NodeSDK | null = null;

export async function initOtel(): Promise<void> {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces';

  try {
    // OTel JS v1.x exposes the Resource constructor; v2.x switches to
    // `resourceFromAttributes(...)`. package.json is pinned ^1.27 so we use
    // the class; bump + switch is a Phase 1 TODO when we adopt v2.
    sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: 'skippy-agent-runtime',
        [ATTR_SERVICE_VERSION]: '0.1.0',
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
    });
    sdk.start();
    logger.info({ msg: 'otel initialized', endpoint });
  } catch (err) {
    // Soft-fail: Phase 0 must boot even without a collector running.
    logger.warn({ msg: 'otel init failed; continuing without telemetry', err: String(err) });
    sdk = null;
  }
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    logger.info({ msg: 'otel shutdown complete' });
  } catch (err) {
    logger.warn({ msg: 'otel shutdown error', err: String(err) });
  }
}

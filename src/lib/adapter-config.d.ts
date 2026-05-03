// This file extends the AdapterConfig type from "@iobroker/types"

declare global {
	namespace ioBroker {
		interface AdapterConfig {
			controllerHost: string;
			controllerPort: number;
			apiToken: string;
			verifyTLS: boolean;
			caCert: string;

			wsReconnectDelay: number;

			defaultUnlockDuration: number;

			// Shared HTTP(S) server (UniFi webhook receiver, thumbnail proxy, generic webhook)
			listenPort: number;
			listenIp: string;
			enableTls: boolean;
			certPublic: string;
			certPrivate: string;
			certChained: string;

			enableWebhooks: boolean;

			enableThumbnailServer: boolean;

			forwardEvents: { event: string; deviceId?: string; targetState: string }[];

			webhookEndpointId: string;
			webhookSecret: string;

			enableGenericWebhook: boolean;
			genericWebhookPath: string;
			genericWebhookAuth: 'none' | 'basic' | 'bearer';
			genericWebhookUsername: string;
			genericWebhookPassword: string;
			genericWebhookToken: string;

			enableProtect: boolean;
			protectUsername: string;
			protectPassword: string;
			protectVerifyTLS: boolean;
		}
	}
}

export {};

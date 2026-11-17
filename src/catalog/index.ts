import type { CatalogTemplate } from "../contracts/operator.ts";

/** Data templates are copied into independent runtime definitions. */
export const templates: CatalogTemplate[] = [
  {
    id: "slack-bot",
    name: "Slack bot",
    description: "Bot OAuth token, workspace identity, token rotation and signed events.",
    definition: {
      ownership: "shared",
      scopes: [],
      audience: [],
      enabled: true,
      privateHosts: false,
      credentialPlacement: {
        kind: "bearer",
      },
      id: "",
      displayName: "Slack bot",
      apiHosts: ["https://slack.com/api", "https://files.slack.com"],
      authentication: {
        method: "authorization_code",
        authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
        tokenEndpoint: "https://slack.com/api/oauth.v2.access",
        clientAuthentication: {
          method: "client_secret_basic",
          clientId: "",
        },
        pkce: "none",
        scopeParameter: {
          name: "scope",
          separator: ",",
        },
        response: {
          format: "json",
          rules: {
            successStatuses: [200],
            success: [
              {
                path: ["ok"],
                equals: true,
              },
            ],
            failure: [
              {
                path: ["ok"],
                equals: false,
              },
            ],
            rejectedGrant: [
              {
                path: ["error"],
                equals: "invalid_refresh_token",
              },
              {
                path: ["error"],
                equals: "invalid_grant",
              },
              {
                path: ["error"],
                equals: "token_revoked",
              },
              {
                path: ["error"],
                equals: "token_expired",
              },
              {
                path: ["error"],
                equals: "invalid_code",
              },
              {
                path: ["error"],
                equals: "code_already_used",
              },
            ],
          },
          mapping: {
            accessToken: ["access_token"],
            refreshToken: ["refresh_token"],
            expiresIn: ["expires_in"],
            scope: ["scope"],
            scopeSeparator: ",",
            accountId: [
              ["team", "id"],
              ["enterprise", "id"],
            ],
            accountName: [
              ["team", "name"],
              ["enterprise", "name"],
            ],
          },
        },
        refreshResponse: {
          format: "json",
          rules: {
            successStatuses: [200],
            success: [
              {
                path: ["ok"],
                equals: true,
              },
            ],
            failure: [
              {
                path: ["ok"],
                equals: false,
              },
            ],
            rejectedGrant: [
              {
                path: ["error"],
                equals: "invalid_refresh_token",
              },
              {
                path: ["error"],
                equals: "invalid_grant",
              },
              {
                path: ["error"],
                equals: "token_revoked",
              },
              {
                path: ["error"],
                equals: "token_expired",
              },
              {
                path: ["error"],
                equals: "invalid_code",
              },
              {
                path: ["error"],
                equals: "code_already_used",
              },
            ],
          },
          mapping: {
            accessToken: ["access_token"],
            refreshToken: ["refresh_token"],
            expiresIn: ["expires_in"],
            scope: ["scope"],
            scopeSeparator: ",",
            accountId: [
              ["team", "id"],
              ["enterprise", "id"],
            ],
            accountName: [
              ["team", "name"],
              ["enterprise", "name"],
            ],
          },
        },
      },
      webhook: {
        verification: {
          kind: "hmac",
          algorithm: "sha256",
          header: "x-slack-signature",
          prefix: "v0=",
          encoding: "hex",
          timestamp: {
            header: "x-slack-request-timestamp",
            toleranceSeconds: 300,
          },
          parts: [
            {
              literal: "v0:",
            },
            {
              timestamp: true,
            },
            {
              literal: ":",
            },
            {
              rawBody: true,
            },
          ],
        },
        handshake: {
          kind: "verified-json-echo",
          when: {
            path: ["type"],
            equals: "url_verification",
          },
          value: ["challenge"],
          response: "text",
        },
        event: {
          id: {
            json: ["event_id"],
          },
          type: {
            json: ["event", "type"],
          },
          account: [
            {
              json: ["team_id"],
            },
            {
              json: ["enterprise_id"],
            },
            {
              json: ["event", "team"],
            },
          ],
          omit: [["token"]],
        },
      },
      accountLookup: {
        url: "https://slack.com/api/auth.test",
        method: "POST",
        credential: "accessToken",
        encoding: "form",
        response: {
          successStatuses: [200],
          success: [
            {
              path: ["ok"],
              equals: true,
            },
          ],
          failure: [
            {
              path: ["ok"],
              equals: false,
            },
          ],
          rejectedGrant: [
            {
              path: ["error"],
              equals: "invalid_refresh_token",
            },
            {
              path: ["error"],
              equals: "invalid_grant",
            },
            {
              path: ["error"],
              equals: "token_revoked",
            },
            {
              path: ["error"],
              equals: "token_expired",
            },
            {
              path: ["error"],
              equals: "invalid_code",
            },
            {
              path: ["error"],
              equals: "code_already_used",
            },
          ],
        },
        id: [["team_id"], ["enterprise_id"]],
        name: [["team"], ["enterprise_name"]],
      },
      revocation: {
        url: "https://slack.com/api/auth.revoke",
        method: "POST",
        credential: "accessToken",
        encoding: "form",
        response: {
          successStatuses: [200],
          success: [
            {
              path: ["ok"],
              equals: true,
            },
          ],
          failure: [
            {
              path: ["ok"],
              equals: false,
            },
          ],
          rejectedGrant: [
            {
              path: ["error"],
              equals: "invalid_refresh_token",
            },
            {
              path: ["error"],
              equals: "invalid_grant",
            },
            {
              path: ["error"],
              equals: "token_revoked",
            },
            {
              path: ["error"],
              equals: "token_expired",
            },
            {
              path: ["error"],
              equals: "invalid_code",
            },
            {
              path: ["error"],
              equals: "code_already_used",
            },
          ],
        },
      },
    },
  },
  {
    id: "slack-user",
    name: "Slack user",
    description: "User OAuth token, workspace identity, token rotation and signed events.",
    definition: {
      ownership: "personal",
      scopes: [],
      audience: [],
      enabled: true,
      privateHosts: false,
      credentialPlacement: {
        kind: "bearer",
      },
      id: "",
      displayName: "Slack user",
      apiHosts: ["https://slack.com/api", "https://files.slack.com"],
      authentication: {
        method: "authorization_code",
        authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
        tokenEndpoint: "https://slack.com/api/oauth.v2.access",
        clientAuthentication: {
          method: "client_secret_basic",
          clientId: "",
        },
        pkce: "none",
        scopeParameter: {
          name: "user_scope",
          separator: ",",
        },
        response: {
          format: "json",
          rules: {
            successStatuses: [200],
            success: [
              {
                path: ["ok"],
                equals: true,
              },
            ],
            failure: [
              {
                path: ["ok"],
                equals: false,
              },
            ],
            rejectedGrant: [
              {
                path: ["error"],
                equals: "invalid_refresh_token",
              },
              {
                path: ["error"],
                equals: "invalid_grant",
              },
              {
                path: ["error"],
                equals: "token_revoked",
              },
              {
                path: ["error"],
                equals: "token_expired",
              },
              {
                path: ["error"],
                equals: "invalid_code",
              },
              {
                path: ["error"],
                equals: "code_already_used",
              },
            ],
          },
          mapping: {
            accessToken: ["authed_user", "access_token"],
            refreshToken: ["authed_user", "refresh_token"],
            expiresIn: ["authed_user", "expires_in"],
            scope: ["authed_user", "scope"],
            scopeSeparator: ",",
            accountId: [
              ["team", "id"],
              ["enterprise", "id"],
            ],
            accountName: [
              ["team", "name"],
              ["enterprise", "name"],
            ],
          },
        },
        refreshResponse: {
          format: "json",
          rules: {
            successStatuses: [200],
            success: [
              {
                path: ["ok"],
                equals: true,
              },
            ],
            failure: [
              {
                path: ["ok"],
                equals: false,
              },
            ],
            rejectedGrant: [
              {
                path: ["error"],
                equals: "invalid_refresh_token",
              },
              {
                path: ["error"],
                equals: "invalid_grant",
              },
              {
                path: ["error"],
                equals: "token_revoked",
              },
              {
                path: ["error"],
                equals: "token_expired",
              },
              {
                path: ["error"],
                equals: "invalid_code",
              },
              {
                path: ["error"],
                equals: "code_already_used",
              },
            ],
          },
          mapping: {
            accessToken: ["access_token"],
            refreshToken: ["refresh_token"],
            expiresIn: ["expires_in"],
            scope: ["scope"],
            scopeSeparator: ",",
            accountId: [
              ["team", "id"],
              ["enterprise", "id"],
            ],
            accountName: [
              ["team", "name"],
              ["enterprise", "name"],
            ],
          },
        },
      },
      webhook: {
        verification: {
          kind: "hmac",
          algorithm: "sha256",
          header: "x-slack-signature",
          prefix: "v0=",
          encoding: "hex",
          timestamp: {
            header: "x-slack-request-timestamp",
            toleranceSeconds: 300,
          },
          parts: [
            {
              literal: "v0:",
            },
            {
              timestamp: true,
            },
            {
              literal: ":",
            },
            {
              rawBody: true,
            },
          ],
        },
        handshake: {
          kind: "verified-json-echo",
          when: {
            path: ["type"],
            equals: "url_verification",
          },
          value: ["challenge"],
          response: "text",
        },
        event: {
          id: {
            json: ["event_id"],
          },
          type: {
            json: ["event", "type"],
          },
          account: [
            {
              json: ["team_id"],
            },
            {
              json: ["enterprise_id"],
            },
            {
              json: ["event", "team"],
            },
          ],
          omit: [["token"]],
        },
      },
      accountLookup: {
        url: "https://slack.com/api/auth.test",
        method: "POST",
        credential: "accessToken",
        encoding: "form",
        response: {
          successStatuses: [200],
          success: [
            {
              path: ["ok"],
              equals: true,
            },
          ],
          failure: [
            {
              path: ["ok"],
              equals: false,
            },
          ],
          rejectedGrant: [
            {
              path: ["error"],
              equals: "invalid_refresh_token",
            },
            {
              path: ["error"],
              equals: "invalid_grant",
            },
            {
              path: ["error"],
              equals: "token_revoked",
            },
            {
              path: ["error"],
              equals: "token_expired",
            },
            {
              path: ["error"],
              equals: "invalid_code",
            },
            {
              path: ["error"],
              equals: "code_already_used",
            },
          ],
        },
        id: [["team_id"], ["enterprise_id"]],
        name: [["team"], ["enterprise_name"]],
      },
      revocation: {
        url: "https://slack.com/api/auth.revoke",
        method: "POST",
        credential: "accessToken",
        encoding: "form",
        response: {
          successStatuses: [200],
          success: [
            {
              path: ["ok"],
              equals: true,
            },
          ],
          failure: [
            {
              path: ["ok"],
              equals: false,
            },
          ],
          rejectedGrant: [
            {
              path: ["error"],
              equals: "invalid_refresh_token",
            },
            {
              path: ["error"],
              equals: "invalid_grant",
            },
            {
              path: ["error"],
              equals: "token_revoked",
            },
            {
              path: ["error"],
              equals: "token_expired",
            },
            {
              path: ["error"],
              equals: "invalid_code",
            },
            {
              path: ["error"],
              equals: "code_already_used",
            },
          ],
        },
      },
    },
  },
  {
    id: "google-service-account",
    name: "Google service account",
    description:
      "Service-account JSON import, RFC 7523 exchange and global or regional Vertex AI hosts.",
    definition: {
      ownership: "shared",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      audience: [],
      enabled: true,
      privateHosts: false,
      credentialPlacement: {
        kind: "bearer",
      },
      id: "",
      displayName: "Google service account",
      apiHosts: ["https://aiplatform.googleapis.com", "https://*-aiplatform.googleapis.com"],
      authentication: {
        method: "jwt_bearer",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientAuthentication: {
          method: "none",
        },
        jwt: {
          algorithm: "RS256",
          issuer: {
            credential: "issuer",
          },
          subject: {
            credential: "issuer",
          },
          audience: "https://oauth2.googleapis.com/token",
          scope: {
            source: "scopes",
            separator: " ",
          },
          keyId: {
            credential: "keyId",
          },
          ttlSeconds: 3600,
        },
        response: {
          format: "json",
          rules: {
            successStatuses: [200],
            rejectedGrant: [
              {
                path: ["error"],
                equals: "invalid_grant",
              },
            ],
          },
          mapping: {
            accessToken: ["access_token"],
            refreshToken: ["refresh_token"],
            expiresIn: ["expires_in"],
            scope: ["scope"],
            scopeSeparator: " ",
          },
        },
      },
      credentialImport: {
        format: "json",
        fields: {
          privateKey: ["private_key"],
          issuer: ["client_email"],
          keyId: ["private_key_id"],
        },
        tokenEndpoint: ["token_uri"],
      },
    },
  },
  {
    id: "api-key",
    name: "API key",
    description: "A shared or personal static key with declarative credential placement.",
    definition: {
      ownership: "shared",
      scopes: [],
      audience: [],
      enabled: true,
      privateHosts: false,
      credentialPlacement: {
        kind: "header",
        name: "X-API-Key",
      },
      id: "",
      displayName: "API key",
      apiHosts: [],
      authentication: {
        method: "static",
      },
    },
  },
  {
    id: "oauth2",
    name: "OAuth 2.0",
    description: "Authorization code with S256 PKCE and a standard token response.",
    definition: {
      ownership: "shared",
      scopes: [],
      audience: [],
      enabled: true,
      privateHosts: false,
      credentialPlacement: {
        kind: "bearer",
      },
      id: "",
      displayName: "OAuth 2.0",
      apiHosts: [],
      authentication: {
        method: "authorization_code",
        authorizationEndpoint: "",
        tokenEndpoint: "",
        clientAuthentication: {
          method: "client_secret_basic",
          clientId: "",
        },
        pkce: "S256",
        scopeParameter: {
          name: "scope",
          separator: " ",
        },
        response: {
          format: "json",
          rules: {
            successStatuses: [200],
            rejectedGrant: [
              {
                path: ["error"],
                equals: "invalid_grant",
              },
            ],
          },
          mapping: {
            accessToken: ["access_token"],
            refreshToken: ["refresh_token"],
            expiresIn: ["expires_in"],
            scope: ["scope"],
            scopeSeparator: " ",
          },
        },
      },
    },
  },
];

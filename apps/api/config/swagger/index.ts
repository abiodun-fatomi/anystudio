/**
 * OpenAPI documentation at /api/v1/docs.
 *
 * Never in production. The document lists every route and its shapes, which
 * is exactly the map an attacker would like; staging and development get it
 * because the people building against the API need it there.
 */
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export default class SwaggerConfig {
  /** Mount the UI, or do nothing in production. */
  set(app: INestApplication): void {
    if (!SwaggerConfig.enabled()) return;

    const options = new DocumentBuilder()
      .setTitle('AnyStudio API')
      .setDescription(
        'One product photo in; branded images, a description, captions and a reel out. ' +
        'Human surfaces authenticate with a per-surface session cookie; the organization API with an issued key.',
      )
      .setVersion('1.0')
      .addCookieAuth('__Host-as_app', { type: 'apiKey', in: 'cookie', name: '__Host-as_app' }, 'session')
      .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'An API key from the developer portal: as_live_… or as_test_…' }, 'apiKey')
      .build();

    const document = SwaggerModule.createDocument(app, options);
    SwaggerModule.setup('api/v1/docs', app, document, {
      customSiteTitle: 'AnyStudio API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    });
  }

  /** Production never; otherwise on unless SWAGGER_ENABLED says off. */
  static enabled(): boolean {
    if (process.env.NODE_ENV === 'production' && process.env.APP_ENV === 'production') return false;
    const v = process.env.SWAGGER_ENABLED;
    return v === undefined ? true : v === 'true';
  }
}

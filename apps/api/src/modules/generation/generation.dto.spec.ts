import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ApiCreateGenerationDto } from '../developer/public-api.dto';
import { CreateGenerationDto } from './generation.dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidUnknownValues: false });
const metadata = <T>(metatype: new () => T) => ({ type: 'body' as const, metatype, data: undefined });

describe('generation request DTOs', () => {
  it.each([CreateGenerationDto, ApiCreateGenerationDto])('strips a caller-supplied costCode from %p', async (metatype) => {
    const value = await pipe.transform(
      {
        capability: 'TEXT_GENERATE',
        params: { productName: 'Ankara tote' },
        clientKey: 'request-1',
        costCode: 'video.shot',
      },
      metadata(metatype),
    );

    expect(value).not.toHaveProperty('costCode');
  });
});

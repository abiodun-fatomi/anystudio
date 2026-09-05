import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class InsightsQueryDto {
  @ApiPropertyOptional({ minimum: 7, maximum: 365, default: 30, description: 'How far back to look' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(7) @Max(365)
  days?: number;
}

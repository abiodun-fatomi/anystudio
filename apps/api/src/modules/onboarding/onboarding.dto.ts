import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

export class TourKeyDto {
  @ApiProperty({ example: 'app.first-run@1' })
  @IsString() @MaxLength(80)
  tourKey: string;
}

export class TourProgressDto extends TourKeyDto {
  @ApiProperty({ minimum: 0, maximum: 50 })
  @IsInt() @Min(0) @Max(50)
  stepIndex: number;
}

export class TourFinishDto extends TourKeyDto {
  @ApiProperty({ enum: ['SKIPPED', 'COMPLETED'] })
  @IsIn(['SKIPPED', 'COMPLETED'])
  outcome: 'SKIPPED' | 'COMPLETED';
}

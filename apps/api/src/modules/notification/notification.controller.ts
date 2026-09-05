import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentActor } from '../auth/decorators';
import type { Actor } from '../auth/policy';
import { NotificationService } from './notification.service';

class ListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
  @IsOptional() @IsString() @MaxLength(40) cursor?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() unread?: boolean;
}
class ReadDto {
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) ids?: string[];
  @IsOptional() @IsBoolean() all?: boolean;
}

@ApiTags('notifications')
@ApiCookieAuth('session')
@Controller({ path: 'me/notifications', version: '1' })
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'The bell: personal notifications and platform messages, newest first, with the unread count' })
  list(@CurrentActor() actor: Actor, @Query() q: ListQueryDto) { return this.notifications.list(actor.userId, { take: q.take, cursor: q.cursor, unreadOnly: q.unread }); }

  @Get('/unread')
  @ApiOperation({ summary: 'Just the count, for polling' })
  async unread(@CurrentActor() actor: Actor) { return { unread: await this.notifications.unreadCount(actor.userId) }; }

  @Post('/read') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark some (ids) or all read' })
  read(@CurrentActor() actor: Actor, @Body() body: ReadDto) { return this.notifications.markRead(actor.userId, body.all ? 'all' : body.ids ?? []); }
}

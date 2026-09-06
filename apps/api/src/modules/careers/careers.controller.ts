/** Careers: the public side (openings, one CV upload, one application) and the staff side (write openings, read applications). */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CareersService } from './careers.service';
import { ApplicationPatchDto, ApplicationsQueryDto, ApplyDto, CvUploadDto, JobDto, JobPatchDto } from './careers.dto';
import { CurrentActor, Public, RequireStaff, RequireSurface } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('careers')
@Controller({ path: 'careers', version: '1' })
export class CareersController {
  constructor(private readonly careers: CareersService) {}

  @Public()
  @Get('/jobs')
  @ApiOperation({ summary: 'Open roles' })
  openings() {
    return this.careers.openings();
  }

  @Public()
  @Get('/jobs/:slug')
  @ApiOperation({ summary: 'One open role' })
  opening(@Param('slug') slug: string) {
    return this.careers.opening(slug);
  }

  @Public()
  @Post('/cv-upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'A signed PUT for a CV (PDF or Word, up to 8 MB)' })
  cvUpload(@Body() body: CvUploadDto) {
    return this.careers.presignCv(body);
  }

  @Public()
  @Post('/apply')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Apply for an open role' })
  apply(@Body() body: ApplyDto, @Req() req: Request) {
    return this.careers.apply(body, req);
  }
}

@ApiTags('admin')
@RequireSurface('ADMIN')
@RequireStaff('SUPPORT')
@Controller({ path: 'admin/careers', version: '1' })
export class AdminCareersController {
  constructor(private readonly careers: CareersService) {}

  @Get('/jobs')
  @ApiOperation({ summary: 'Every opening, with application counts' })
  jobs() {
    return this.careers.jobs();
  }

  @Post('/jobs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Write an opening (staff ADMIN)' })
  create(@CurrentActor() a: Actor, @Body() b: JobDto, @Req() req: Request) {
    return this.careers.createJob(a, b, req);
  }

  @Patch('/jobs/:id')
  @ApiOperation({ summary: 'Change an opening; status OPEN publishes it' })
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() b: JobPatchDto, @Req() req: Request) {
    return this.careers.updateJob(a, id, b, req);
  }

  @Delete('/jobs/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an opening that has no applications' })
  remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.careers.deleteJob(a, id, req);
  }

  @Get('/applications')
  @ApiOperation({ summary: 'Applications, newest first' })
  applications(@CurrentActor() a: Actor, @Query() q: ApplicationsQueryDto) {
    return this.careers.applications(a, q);
  }

  @Get('/applications/:id')
  @ApiOperation({ summary: 'One application with a short-lived CV link' })
  application(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.careers.application(a, id);
  }

  @Patch('/applications/:id')
  @ApiOperation({ summary: 'Move an application along, or leave a note' })
  patch(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() b: ApplicationPatchDto, @Req() req: Request) {
    return this.careers.updateApplication(a, id, b, req);
  }
}

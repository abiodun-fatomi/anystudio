#!/usr/bin/env ruby
# Static counterpart to render-preflight.sh. This runs on pull requests, where
# Render credentials are intentionally unavailable, and prevents a valid YAML
# file from weakening the production runtime contract.

require 'yaml'

ENVIRONMENTS = {
  'render.yaml' => {
    branch: 'development', suffix: '-dev', app_env: 'dev',
    api_plan: '0.5c-512mb', api_instances: 1, worker_plan: '0.5c-512mb',
    worker_node_options: '--max-old-space-size=384', worker_fast: '6', worker_heavy: '8'
  },
  'render.staging.yaml' => {
    branch: 'staging', suffix: '-staging', app_env: 'staging',
    api_plan: '0.5c-512mb', api_instances: 1, worker_plan: '0.5c-512mb',
    worker_node_options: '--max-old-space-size=384', worker_fast: '6', worker_heavy: '8'
  },
  'render.production.yaml' => {
    branch: 'production', suffix: '', app_env: 'production',
    api_plan: '1c-2g', api_instances: 1, worker_plan: '1c-2g',
    worker_node_options: '--max-old-space-size=1536', worker_fast: '12', worker_heavy: '16'
  }
}.freeze

def env(service)
  service.fetch('envVars', []).each_with_object({}) do |item, values|
    values[item['key']] = item['value'] if item.key?('key')
  end.to_h
end

def assert!(condition, message)
  raise message unless condition
end

resource_names = []

ENVIRONMENTS.each do |file, expected|
  blueprint = YAML.safe_load(File.read(file), aliases: false)
  assert!(!blueprint.key?('envVarGroups'), "#{file}: secret groups must be manually managed, not redefined")

  database = blueprint.fetch('databases').fetch(0)
  assert!(database['postgresMajorVersion'].to_s == '18', "#{file}: PostgreSQL must match CI at major version 18")
  resource_names << database.fetch('name')

  services = blueprint.fetch('services')
  resource_names.concat(services.map { |service| service.fetch('name') })
  by_name = services.to_h { |service| [service.fetch('name'), service] }
  api = by_name.fetch("anystudio-api#{expected[:suffix]}")
  worker = by_name.fetch("anystudio-worker#{expected[:suffix]}")
  media = by_name.fetch("anystudio-media#{expected[:suffix]}")

  { 'api' => api, 'worker' => worker, 'media' => media }.each do |role, service|
    values = env(service)
    assert!(service['branch'] == expected[:branch], "#{file}: #{role} must use branch #{expected[:branch]}")
    assert!(service['runtime'] == 'docker', "#{file}: #{role} must use the shared Docker image")
    assert!(service['dockerfilePath'] == './apps/api/Dockerfile', "#{file}: #{role} Dockerfile path drifted")
    assert!(service['dockerContext'] == '.', "#{file}: #{role} Docker context drifted")
    assert!(service['region'] == 'frankfurt', "#{file}: #{role} must remain in Frankfurt")
    assert!(service['autoDeployTrigger'] == 'off', "#{file}: #{role} auto-deploy must remain off")
    assert!(values['APP_ENV'] == expected[:app_env], "#{file}: #{role} APP_ENV must be #{expected[:app_env]}")
    assert!(values['NODE_ENV'] == 'production', "#{file}: #{role} NODE_ENV must be production")
    assert!(values['SERVICE_NAME'] == role, "#{file}: #{role} SERVICE_NAME must be #{role}")
    groups = service.fetch('envVars').map { |item| item['fromGroup'] }.compact
    assert!(groups == ["anystudio-#{expected[:app_env]}"], "#{file}: #{role} must link exactly one environment secret group")
  end

  assert!(api['type'] == 'web', "#{file}: API must remain a web service")
  assert!(worker['type'] == 'worker' && media['type'] == 'worker', "#{file}: both queue consumers must be background workers")
  assert!(api['plan'] == expected[:api_plan], "#{file}: API compute plan drifted")
  assert!(api['numInstances'] == expected[:api_instances], "#{file}: API instance count drifted")

  # More than one API instance means more than one Prisma connection pool
  # against the same Postgres. Without a pooler in front of it the database
  # runs out of connections under load, and the symptom is requests timing out
  # at random rather than anything that names connections. So the instance
  # count and the pooler are one decision, and this is where that is enforced.
  #
  # DIRECT_URL must stay on the direct string whatever happens: `migrate
  # deploy` takes an advisory lock and runs DDL, and neither survives a
  # transaction pooler.
  if api['numInstances'].to_i > 1
    assert!(database['connectionPool'], "#{file}: #{api['numInstances']} API instances need `connectionPool` on the database")
    api_db = api.fetch('envVars').find { |item| item['key'] == 'DATABASE_URL' }
    api_direct = api.fetch('envVars').find { |item| item['key'] == 'DIRECT_URL' }
    assert!(api_db.dig('fromDatabase', 'property') == 'connectionPoolString',
            "#{file}: with a pooler, DATABASE_URL must use connectionPoolString")
    assert!(api_direct.dig('fromDatabase', 'property') == 'connectionString',
            "#{file}: DIRECT_URL must stay on the direct connection — migrations cannot run through a pooler")
  end
  assert!(api['preDeployCommand'] == 'npm run release', "#{file}: API must run migrations before every deploy")
  assert!(!worker.key?('preDeployCommand') && !media.key?('preDeployCommand'), "#{file}: only the API may run the pre-deploy migration command")
  assert!(worker['plan'] == expected[:worker_plan], "#{file}: main worker compute plan drifted")
  assert!(worker['numInstances'] == 1 && media['numInstances'] == 1, "#{file}: each queue worker must have exactly one instance")
  assert!(worker['maxShutdownDelaySeconds'] == 300, "#{file}: main worker must retain Render's maximum graceful shutdown window")
  assert!(media['maxShutdownDelaySeconds'] == 300, "#{file}: media worker must retain Render's maximum graceful shutdown window")
  assert!(worker['dockerCommand'] == 'node dist/src/worker/main.js', "#{file}: main worker command drifted")
  assert!(media['dockerCommand'] == 'node dist/src/worker/main.js', "#{file}: media worker command drifted")
  assert!(env(worker)['NODE_OPTIONS'] == expected[:worker_node_options], "#{file}: main worker heap limit drifted")
  assert!(env(worker)['WORKER_FAST_CONCURRENCY'] == expected[:worker_fast], "#{file}: main worker fast concurrency drifted")
  assert!(env(worker)['WORKER_HEAVY_CONCURRENCY'] == expected[:worker_heavy], "#{file}: main worker heavy concurrency drifted")
  assert!(env(worker)['WORKER_QUEUES'] == 'media.fast,media.heavy', "#{file}: main worker queue isolation drifted")
  assert!(env(worker)['FFMPEG_CONCURRENCY'] == '1', "#{file}: main worker must serialize thumbnail ffmpeg processes")
  assert!(env(media)['WORKER_QUEUES'] == 'media.local', "#{file}: media worker queue isolation drifted")
  assert!(env(media)['WORKER_LOCAL_CONCURRENCY'] == '1', "#{file}: media worker must claim one local job")
  assert!(env(media)['WORKER_DIRECT_CONCURRENCY'] == '1', "#{file}: media database fallback must claim one local job")
  assert!(env(media)['FFMPEG_CONCURRENCY'] == '1', "#{file}: media worker must run one ffmpeg process")
  assert!(env(media)['NODE_OPTIONS'] == '--max-old-space-size=1024', "#{file}: media worker heap limit drifted")
  assert!(media['plan'] == '1c-2g', "#{file}: media worker must retain its 2 GB isolation boundary")
end

duplicates = resource_names.group_by(&:itself).select { |_name, occurrences| occurrences.length > 1 }.keys
assert!(duplicates.empty?, "Render resources are owned by more than one Blueprint: #{duplicates.join(', ')}")

# THE TWO FILES THAT MUST AGREE
#
# render-preflight.sh checks the LIVE Render services on every deploy, and it
# carries its own copy of the expected plan, instance count and concurrencies.
# That copy is what makes dashboard drift a failed deploy instead of a silent
# divergence — and it is also a second place to forget when the size changes.
# Scaling up should be one decision, so this asserts the blueprint and the
# live-preflight expectations are the same numbers.
preflight = File.read(File.join(__dir__, 'render-preflight.sh'), encoding: 'UTF-8')

ENVIRONMENTS.each do |file, expected|
  branch = expected[:branch]
  block = preflight[/^  #{Regexp.escape(branch)}\)\n(.*?)^    ;;/m]
  assert!(block, "render-preflight.sh has no case block for '#{branch}'")

  shell = block.scan(/^\s*(EXPECTED_\w+)=(.+)$/).to_h { |k, v| [k, v.strip.delete_prefix("'").delete_suffix("'")] }

  blueprint = YAML.safe_load(File.read(file), aliases: false)
  by_name = blueprint.fetch('services').to_h { |service| [service.fetch('name'), service] }
  api = by_name.fetch("anystudio-api#{expected[:suffix]}")
  worker = by_name.fetch("anystudio-worker#{expected[:suffix]}")

  {
    'EXPECTED_API_PLAN' => api['plan'],
    'EXPECTED_API_INSTANCES' => api['numInstances'].to_s,
    'EXPECTED_WORKER_PLAN' => worker['plan'],
    'EXPECTED_WORKER_NODE_OPTIONS' => env(worker)['NODE_OPTIONS'],
    'EXPECTED_WORKER_FAST_CONCURRENCY' => env(worker)['WORKER_FAST_CONCURRENCY'],
    'EXPECTED_WORKER_HEAVY_CONCURRENCY' => env(worker)['WORKER_HEAVY_CONCURRENCY']
  }.each do |key, from_blueprint|
    assert!(shell[key] == from_blueprint,
            "#{file} says #{key.sub('EXPECTED_', '')}=#{from_blueprint}, render-preflight.sh says #{shell[key]} — change both or the next deploy fails on the live check")
  end
end

puts '✔ Render Blueprints preserve production identity, queue, memory, secret-group and PostgreSQL contracts'

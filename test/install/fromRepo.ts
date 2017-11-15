import tape = require('tape')
import promisifyTape from 'tape-promise'
import isCI = require('is-ci')
import readPkg = require('read-pkg')
import {installPkgs} from 'supi'
import {
  prepare,
  testDefaults,
} from '../utils'

const test = promisifyTape(tape)

test('from a github repo', async function (t) {
  const project = prepare(t)
  await installPkgs(['kevva/is-negative'], testDefaults())

  const m = project.requireModule('is-negative')

  t.ok(m, 'isNegative() is available')

  const pkgJson = await readPkg()
  t.deepEqual(pkgJson.dependencies, {'is-negative': 'github:kevva/is-negative'}, 'has been added to dependencies in package.json')
})

test('from a github repo with different name', async function (t: tape.Test) {
  const project = prepare(t)
  await installPkgs(['say-hi@github:zkochan/hi#4cdebec76b7b9d1f6e219e06c42d92a6b8ea60cd'], testDefaults())

  const m = project.requireModule('say-hi')

  t.equal(m, 'Hi', 'dep is available')

  const pkgJson = await readPkg()
  t.deepEqual(pkgJson.dependencies, {'say-hi': 'github:zkochan/hi#4cdebec76b7b9d1f6e219e06c42d92a6b8ea60cd'}, 'has been added to dependencies in package.json')

  const shr = await project.loadShrinkwrap()
  t.deepEqual(shr.dependencies, {
    'say-hi': 'github.com/zkochan/hi/4cdebec76b7b9d1f6e219e06c42d92a6b8ea60cd',
  }, 'the aliased name added to shrinkwrap.yaml')
})

test('a subdependency is from a github repo with different name', async function (t: tape.Test) {
  const project = prepare(t)

  await installPkgs(['has-aliased-git-dependency'], testDefaults())

  const m = project.requireModule('has-aliased-git-dependency')

  t.equal(m, 'Hi', 'subdep is accessible')

  const shr = await project.loadShrinkwrap()
  t.deepEqual(shr.packages['/has-aliased-git-dependency/1.0.0'].dependencies, {
    'say-hi': 'github.com/zkochan/hi/4cdebec76b7b9d1f6e219e06c42d92a6b8ea60cd',
  }, 'the aliased name added to shrinkwrap.yaml')
})

test('from a git repo', async function (t) {
  if (isCI) {
    t.skip('not testing the SSH GIT access via CI')
    return t.end()
  }
  const project = prepare(t)
  await installPkgs(['git+ssh://git@github.com/kevva/is-negative.git'], testDefaults())

  const m = project.requireModule('is-negative')

  t.ok(m, 'isNegative() is available')
})

test('from a non-github git repo', async function (t) {
  const project = prepare(t)

  await installPkgs(['git+http://ikt.pm2.io/ikt.git#3325a3e39a502418dc2e2e4bf21529cbbde96228'], testDefaults())

  const m = project.requireModule('ikt')

  t.ok(m, 'ikt is available')

  const shr = await project.loadShrinkwrap()

  const pkgId = 'ikt.pm2.io/ikt/3325a3e39a502418dc2e2e4bf21529cbbde96228'
  t.ok(shr.packages[pkgId])
  t.deepEqual(shr.packages[pkgId].resolution, {
    commit: '3325a3e39a502418dc2e2e4bf21529cbbde96228',
    repo: 'http://ikt.pm2.io/ikt.git',
    type: 'git',
  })
})

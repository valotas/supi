import fs = require('mz/fs')
import path = require('path')
import symlinkDir = require('symlink-dir')
import exists = require('path-exists')
import logger, {rootLogger} from 'pnpm-logger'
import R = require('ramda')
import pLimit = require('p-limit')
import {InstalledPackage} from '../install/installMultiple'
import {InstalledPackages, TreeNode} from '../api/install'
import linkBins, {linkPkgBins} from './linkBins'
import {Package, Dependencies} from '../types'
import {Resolution, PackageContentInfo, Store} from 'package-store'
import resolvePeers, {DependencyTreeNode, DependencyTreeNodeMap} from './resolvePeers'
import logStatus from '../logging/logInstallStatus'
import updateShrinkwrap, {DependencyShrinkwrapContainer} from './updateShrinkwrap'
import * as dp from 'dependency-path'
import {
  Shrinkwrap,
  DependencyShrinkwrap,
  prune as pruneShrinkwrap,
} from 'pnpm-shrinkwrap'
import removeOrphanPkgs from '../api/removeOrphanPkgs'
import linkIndexedDir from '../fs/linkIndexedDir'
import ncpCB = require('ncp')
import thenify = require('thenify')
import Rx = require('@reactivex/rxjs')

const ncp = thenify(ncpCB)

export default async function (
  topPkgs: InstalledPackage[],
  rootNodeIds: string[],
  tree: {[nodeId: string]: TreeNode},
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
    bin: string,
    topParents: {name: string, version: string}[],
    shrinkwrap: Shrinkwrap,
    privateShrinkwrap: Shrinkwrap,
    makePartialPrivateShrinkwrap: boolean,
    production: boolean,
    optional: boolean,
    root: string,
    storePath: string,
    storeIndex: Store,
    skipped: Set<string>,
    pkg: Package,
    independentLeaves: boolean,
    nonDevPackageIds: Set<string>,
    nonOptionalPackageIds: Set<string>,
  }
): Promise<{
  linkedPkgsMap: DependencyTreeNodeMap,
  shrinkwrap: Shrinkwrap,
  privateShrinkwrap: Shrinkwrap,
  newPkgResolvedIds: string[],
}> {
  const topPkgIds = topPkgs.map(pkg => pkg.id)
  logger.info(`Creating dependency tree`)
  const pkgsToLink$ = resolvePeers(
    tree,
    rootNodeIds,
    topPkgIds,
    opts.topParents,
    opts.independentLeaves,
    opts.baseNodeModules, {
      nonDevPackageIds: opts.nonDevPackageIds,
      nonOptionalPackageIds: opts.nonOptionalPackageIds,
    })

  let flatResolvedDeps$ =  pkgsToLink$.filter(dep => !opts.skipped.has(dep.id))
  if (opts.production) {
    flatResolvedDeps$ = flatResolvedDeps$.filter(dep => !dep.dev)
  }
  if (!opts.optional) {
    flatResolvedDeps$ = flatResolvedDeps$.filter(dep => !dep.optional)
  }

  const filterOpts = {
    noDev: opts.production,
    noOptional: !opts.optional,
    skipped: opts.skipped,
  }

  const depShr$ = updateShrinkwrap(pkgsToLink$, opts.shrinkwrap, opts.pkg)

  const newPkgResolvedIds$ = linkNewPackages(
    filterShrinkwrap(opts.privateShrinkwrap, filterOpts),
    depShr$,
    opts,
    opts.shrinkwrap.registry
  )

  const shrPackages = opts.shrinkwrap.packages || {}
  await depShr$.forEach(depShr => {
    shrPackages[depShr.dependencyPath] = depShr.dependencyShrinkwrap
  })
  opts.shrinkwrap.packages = shrPackages
  const newShr = await pruneShrinkwrap(opts.shrinkwrap, opts.pkg)

  await removeOrphanPkgs({
    oldShrinkwrap: opts.privateShrinkwrap,
    newShrinkwrap: newShr,
    prefix: opts.root,
    store: opts.storePath,
    storeIndex: opts.storeIndex,
    bin: opts.bin,
  })

  const flatDeps = await flatResolvedDeps$
    .filter(pkg => pkg.depth === 0)
    .reduce((acc, dep) => {
      acc.push(dep)
      return acc
    }, [] as DependencyTreeNode[])
    .toPromise()

  for (let pkg of flatDeps) {
    const symlinkingResult = await symlinkDependencyTo(pkg, opts.baseNodeModules)
    if (!symlinkingResult.reused) {
      rootLogger.info({
        added: {
          id: pkg.id,
          name: pkg.name,
          version: pkg.version,
          dependencyType: pkg.dev && 'dev' || pkg.optional && 'optional' || 'prod',
        },
      })
    }
    logStatus({
      status: 'installed',
      pkgId: pkg.id,
    })
  }

  const newPkgResolvedIds = await newPkgResolvedIds$.reduce((acc: string[], newPkgId) => {
    acc.push(newPkgId)
    return acc
  }, [])
  .toPromise()
  const pkgsToLink = await pkgsToLink$.reduce((acc, pkgToLink) => {
    acc[pkgToLink.absolutePath] = pkgToLink
    return acc
  }, {})
  .toPromise()

  await linkBins(opts.baseNodeModules, opts.bin)

  let privateShrinkwrap: Shrinkwrap
  if (opts.makePartialPrivateShrinkwrap) {
    const packages = opts.privateShrinkwrap.packages || {}
    if (newShr.packages) {
      for (const shortId in newShr.packages) {
        const resolvedId = dp.resolve(newShr.registry, shortId)
        if (pkgsToLink[resolvedId]) {
          packages[shortId] = newShr.packages[shortId]
        }
      }
    }
    privateShrinkwrap = Object.assign({}, newShr, {
      packages,
    })
  } else {
    privateShrinkwrap = newShr
  }

  return {
    linkedPkgsMap: pkgsToLink,
    shrinkwrap: newShr,
    privateShrinkwrap,
    newPkgResolvedIds,
  }
}

function filterShrinkwrap (
  shr: Shrinkwrap,
  opts: {
    noDev: boolean,
    noOptional: boolean,
    skipped: Set<string>,
  }
): Shrinkwrap {
  let pairs = R.toPairs<string, DependencyShrinkwrap>(shr.packages)
    .filter(pair => !opts.skipped.has(pair[1].id || dp.resolve(shr.registry, pair[0])))
  if (opts.noDev) {
    pairs = pairs.filter(pair => !pair[1].dev)
  }
  if (opts.noOptional) {
    pairs = pairs.filter(pair => !pair[1].optional)
  }
  return {
    shrinkwrapVersion: shr.shrinkwrapVersion,
    registry: shr.registry,
    specifiers: shr.specifiers,
    packages: R.fromPairs(pairs),
  } as Shrinkwrap
}

function linkNewPackages (
  privateShrinkwrap: Shrinkwrap,
  nextPkgs$: Rx.Observable<DependencyShrinkwrapContainer>,
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
    optional: boolean,
  },
  registry: string
): Rx.Observable<string> {
  let copy = false
  const prevPackages = privateShrinkwrap.packages || {}
  return nextPkgs$.mergeMap(nextPkg => {
    // TODO: what if the registries differ?
    if (!opts.force && prevPackages[nextPkg.dependencyPath]) {
      // add subdependencies that have been updated
      // TODO: no need to relink everything. Can be relinked only what was changed
      if (!(prevPackages[nextPkg.dependencyPath] &&
        (!R.equals(prevPackages[nextPkg.dependencyPath].dependencies, nextPkg.dependencyShrinkwrap.dependencies) ||
        !R.equals(prevPackages[nextPkg.dependencyPath].optionalDependencies, nextPkg.dependencyShrinkwrap.optionalDependencies)))) {
        return Rx.Observable.empty<DependencyShrinkwrapContainer>()
      }
    }
    return Rx.Observable.of(nextPkg)
  })
  .mergeMap(nextPkg => {
    const activeDeps = nextPkg.dependencies.concat(opts.optional ? nextPkg.optionalDependencies : [])
    return Rx.Observable.fromPromise(
      Promise.all([
        linkModules(nextPkg.dependencyTreeNode, activeDeps),
        (async () => {
          if (copy) {
            await linkPkgToAbsPath(copyPkg, nextPkg.dependencyTreeNode, opts)
          }
          try {
            await linkPkgToAbsPath(linkPkg, nextPkg.dependencyTreeNode, opts)
          } catch (err) {
            if (!err.message.startsWith('EXDEV: cross-device link not permitted')) throw err
            copy = true
            logger.warn(err.message)
            logger.info('Falling back to copying packages from store')
            await linkPkgToAbsPath(copyPkg, nextPkg.dependencyTreeNode, opts)
          }
        })()
      ])
      .then(() => _linkBins(nextPkg.dependencyTreeNode, activeDeps))
    )
    .mapTo(nextPkg)
  })
  .map(nextPkg => nextPkg.dependencyTreeNode.absolutePath)
}

const limitLinking = pLimit(16)

async function linkPkgToAbsPath (
  linkPkg: (fetchResult: PackageContentInfo, dependency: DependencyTreeNode, opts: {
    force: boolean,
    baseNodeModules: string,
  }) => Promise<void>,
  pkg: DependencyTreeNode,
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
  }
) {
  const fetchResult = await pkg.fetchingFiles

  if (pkg.independent) return
  return limitLinking(() => linkPkg(fetchResult, pkg, opts))
}

async function _linkBins (
  dependency: DependencyTreeNode,
  dependencies: DependencyTreeNode[]
) {
  return limitLinking(async () => {
    const binPath = path.join(dependency.hardlinkedLocation, 'node_modules', '.bin')

    await Promise.all(dependencies
      .filter(child => child.installable)
      .map(child => linkPkgBins(path.join(dependency.modules, child.name), binPath)))

    // link also the bundled dependencies` bins
    if (dependency.hasBundledDependencies) {
      const bundledModules = path.join(dependency.hardlinkedLocation, 'node_modules')
      await linkBins(bundledModules, binPath)
    }
  })
}

async function linkModules (
  pkg: DependencyTreeNode,
  deps: DependencyTreeNode[]
) {
  if (pkg.independent) return

  return limitLinking(() => Promise.all(deps
    .filter(child => child.installable)
    .map(child => symlinkDependencyTo(child, pkg.modules)))
  )
}

async function linkPkg (
  fetchResult: PackageContentInfo,
  dependency: DependencyTreeNode,
  opts: {
    force: boolean,
    baseNodeModules: string,
  }
) {
  const pkgJsonPath = path.join(dependency.hardlinkedLocation, 'package.json')

  if (fetchResult.isNew || opts.force || !await exists(pkgJsonPath) || !await pkgLinkedToStore(pkgJsonPath, dependency)) {
    await linkIndexedDir(dependency.path, dependency.hardlinkedLocation, fetchResult.index)
  }
}

async function copyPkg (
  fetchResult: PackageContentInfo,
  dependency: DependencyTreeNode,
  opts: {
    force: boolean,
    baseNodeModules: string,
  }
) {
  const newlyFetched = await dependency.fetchingFiles

  const pkgJsonPath = path.join(dependency.hardlinkedLocation, 'package.json')
  if (newlyFetched || opts.force || !await exists(pkgJsonPath)) {
    await ncp(dependency.path, dependency.hardlinkedLocation)
  }
}

async function pkgLinkedToStore (pkgJsonPath: string, dependency: DependencyTreeNode) {
  const pkgJsonPathInStore = path.join(dependency.path, 'package.json')
  if (await isSameFile(pkgJsonPath, pkgJsonPathInStore)) return true
  logger.info(`Relinking ${dependency.hardlinkedLocation} from the store`)
  return false
}

async function isSameFile (file1: string, file2: string) {
  const stats = await Promise.all([fs.stat(file1), fs.stat(file2)])
  return stats[0].ino === stats[1].ino
}

function symlinkDependencyTo (dependency: DependencyTreeNode, dest: string) {
  dest = path.join(dest, dependency.name)
  return symlinkDir(dependency.hardlinkedLocation, dest)
}

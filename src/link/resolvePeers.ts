import {
  Resolution,
  PackageContentInfo,
  pkgIdToFilename,
} from 'package-store'
import {Dependencies} from '@pnpm/types'
import R = require('ramda')
import semver = require('semver')
import logger from '@pnpm/logger'
import path = require('path')
import {oneLine} from 'common-tags'
import {InstalledPackage} from '../install/installMultiple'
import {TreeNode, TreeNodeMap} from '../api/install'
import {PackageManifest} from '../types'

export type DependencyTreeNode = {
  name: string,
  // at this point the version is really needed only for logging
  version: string,
  hasBundledDependencies: boolean,
  path: string,
  modules: string,
  fetchingFiles: Promise<PackageContentInfo>,
  resolution: Resolution,
  hardlinkedLocation: string,
  children: {[alias: string]: string},
  // an independent package is a package that
  // has neither regular nor peer dependencies
  independent: boolean,
  optionalDependencies: Set<string>,
  depth: number,
  absolutePath: string,
  prod: boolean,
  dev: boolean,
  optional: boolean,
  id: string,
  installable: boolean,
  pkg: PackageManifest,
}

export type DependencyTreeNodeMap = {
  // a node ID is the join of the package's keypath with a colon
  // E.g., a subdeps node ID which parent is `foo` will be
  // registry.npmjs.org/foo/1.0.0:registry.npmjs.org/bar/1.0.0
  [nodeId: string]: DependencyTreeNode
}

export default function (
  tree: TreeNodeMap,
  rootNodeIds: {[alias: string]: string},
  topPkgIds: string[],
  // only the top dependencies that were already installed
  // to avoid warnings about unresolved peer dependencies
  topParents: {name: string, version: string}[],
  independentLeaves: boolean,
  nodeModules: string
): {
  resolvedTree: DependencyTreeNodeMap,
  rootResolvedIds: {[alias: string]: string},
} {
  const pkgsByName = R.fromPairs(
    topParents.map((parent: {name: string, version: string}): R.KeyValuePair<string, ParentRef> => [
      parent.name,
      {
        version: parent.version,
        depth: 0
      }
    ])
  )

  const nodeIdToResolvedId = {}
  const resolvedTree: DependencyTreeNodeMap = {}
  resolvePeersOfChildren(rootNodeIds, pkgsByName, {
    tree,
    nodeIdToResolvedId,
    resolvedTree,
    independentLeaves,
    nodeModules,
    purePkgs: new Set(),
  })

  R.values(resolvedTree).forEach(node => {
    node.children = R.keys(node.children).reduce((acc, alias) => {
      acc[alias] = nodeIdToResolvedId[node.children[alias]]
      return acc
    }, {})
  })
  return {
    resolvedTree,
    rootResolvedIds: R.keys(rootNodeIds).reduce((rootResolvedIds, alias) => {
      rootResolvedIds[alias] = nodeIdToResolvedId[rootNodeIds[alias]]
      return rootResolvedIds
    }, {})
  }
}

function resolvePeersOfNode (
  nodeId: string,
  parentPkgs: ParentRefs,
  ctx: {
    tree: TreeNodeMap,
    nodeIdToResolvedId: {[nodeId: string]: string},
    resolvedTree: DependencyTreeNodeMap,
    independentLeaves: boolean,
    nodeModules: string,
    purePkgs: Set<string>, // pure packages are those that don't rely on externally resolved peers
  }
): {[alias: string]: string} {
  const node = ctx.tree[nodeId]
  if (ctx.purePkgs.has(node.pkg.id) && ctx.resolvedTree[node.pkg.id].depth <= node.depth) {
    ctx.nodeIdToResolvedId[nodeId] = node.pkg.id
    return {}
  }

  const unknownResolvedPeersOfChildren = resolvePeersOfChildren(node.children, parentPkgs, ctx, nodeId)

  const resolvedPeers = R.isEmpty(node.pkg.peerDependencies)
    ? {}
    : resolvePeers(node, Object.assign({}, parentPkgs,
      toPkgByName(R.keys(node.children).map(alias => ({
        alias: alias,
        node: ctx.tree[node.children[alias]],
      })))
    ), ctx.tree)

  const allResolvedPeers = Object.assign({}, unknownResolvedPeersOfChildren, resolvedPeers)

  let modules: string
  let absolutePath: string
  const localLocation = path.join(ctx.nodeModules, `.${pkgIdToFilename(node.pkg.id)}`)
  if (R.isEmpty(allResolvedPeers)) {
    modules = path.join(localLocation, 'node_modules')
    absolutePath = node.pkg.id
    if (R.isEmpty(node.pkg.peerDependencies)) {
      ctx.purePkgs.add(node.pkg.id)
    }
  } else {
    const peersFolder = createPeersFolderName(R.props<TreeNode>(R.values(allResolvedPeers), ctx.tree).map(node => node.pkg))
    modules = path.join(localLocation, peersFolder, 'node_modules')
    absolutePath = `${node.pkg.id}/${peersFolder}`
  }

  ctx.nodeIdToResolvedId[nodeId] = absolutePath
  if (!ctx.resolvedTree[absolutePath] || ctx.resolvedTree[absolutePath].depth > node.depth) {
    const independent = ctx.independentLeaves && R.isEmpty(node.children) && R.isEmpty(node.pkg.peerDependencies)
    const pathToUnpacked = path.join(node.pkg.path, 'node_modules', node.pkg.name)
    const hardlinkedLocation = !independent
      ? path.join(modules, node.pkg.name)
      : pathToUnpacked
    ctx.resolvedTree[absolutePath] = {
      name: node.pkg.name,
      version: node.pkg.version,
      hasBundledDependencies: node.pkg.hasBundledDependencies,
      fetchingFiles: node.pkg.fetchingFiles,
      resolution: node.pkg.resolution,
      path: pathToUnpacked,
      modules,
      hardlinkedLocation,
      independent,
      optionalDependencies: node.pkg.optionalDependencies,
      children: Object.assign({}, node.children, resolvedPeers),
      depth: node.depth,
      absolutePath,
      prod: node.pkg.prod,
      dev: node.pkg.dev,
      optional: node.pkg.optional,
      id: node.pkg.id,
      installable: node.installable,
      pkg: node.pkg.pkg,
    }
  }
  return allResolvedPeers
}

function addMany<T>(a: Set<T>, b: Set<T>) {
  for (const el of Array.from(b)) {
    a.add(el)
  }
  return a
}

function union<T>(a: Set<T>, b: Set<T>) {
  return new Set(Array.from(a).concat(Array.from(b)))
}

function difference<T>(a: Set<T>, b: Set<T>) {
  return new Set(Array.from(a).filter(el => !b.has(el)))
}

function resolvePeersOfChildren (
  children: {
    [alias: string]: string,
  },
  parentParentPkgs: ParentRefs,
  ctx: {
    tree: {[nodeId: string]: TreeNode},
    nodeIdToResolvedId: {[nodeId: string]: string},
    resolvedTree: DependencyTreeNodeMap,
    independentLeaves: boolean,
    nodeModules: string,
    purePkgs: Set<string>,
  },
  exceptNodeId?: string,
): {[alias: string]: string} {
  let allResolvedPeers: {[alias: string]: string} = {}
  const parentPkgs = Object.assign({}, parentParentPkgs,
    toPkgByName(R.keys(children).map(alias => ({alias: alias, node: ctx.tree[children[alias]]})))
  )

  for (const childNodeId of R.values(children)) {
    Object.assign(allResolvedPeers, resolvePeersOfNode(childNodeId, parentPkgs, ctx))
  }

  const unknownResolvedPeersOfChildren = R.keys(allResolvedPeers)
    .filter(alias => !children[alias] && allResolvedPeers[alias] !== exceptNodeId)
    .reduce((unknownResolvedPeersOfChildren, peer) => {
      unknownResolvedPeersOfChildren[peer] = allResolvedPeers[peer]
      return unknownResolvedPeersOfChildren
    }, {})

  return unknownResolvedPeersOfChildren
}

function resolvePeers (
  node: TreeNode,
  parentPkgs: ParentRefs,
  tree: TreeNodeMap
): {
  [alias: string]: string
} {
  const resolvedPeers: {[alias: string]: string} = {}
  for (const peerName in node.pkg.peerDependencies) {
    const peerVersionRange = node.pkg.peerDependencies[peerName]

    const resolved = parentPkgs[peerName]

    if (!resolved || resolved.nodeId && !tree[resolved.nodeId].installable) {
      const friendlyPath = nodeIdToFriendlyPath(node.nodeId, tree)
      logger.warn(oneLine`
        ${friendlyPath ? `${friendlyPath}: ` : ''}${packageFriendlyId(node.pkg)}
        requires a peer of ${peerName}@${peerVersionRange} but none was installed.`
      )
      continue
    }

    if (!semver.satisfies(resolved.version, peerVersionRange)) {
      const friendlyPath = nodeIdToFriendlyPath(node.nodeId, tree)
      logger.warn(oneLine`
        ${friendlyPath ? `${friendlyPath}: ` : ''}${packageFriendlyId(node.pkg)}
        requires a peer of ${peerName}@${peerVersionRange} but version ${resolved.version} was installed.`
      )
    }

    if (resolved.depth === 0 || resolved.depth === node.depth + 1) {
      // if the resolved package is a top dependency
      // or the peer dependency is resolved from a regular dependency of the package
      // then there is no need to link it in
      continue
    }

    if (resolved && resolved.nodeId) resolvedPeers[peerName] = resolved.nodeId
  }
  return resolvedPeers
}

function packageFriendlyId (pkg: {name: string, version: string}) {
  return `${pkg.name}@${pkg.version}`
}

function nodeIdToFriendlyPath (nodeId: string, tree: TreeNodeMap) {
  const parts = nodeId.split(':').slice(2, -2)
  return R.tail(R.scan((prevNodeId, pkgId) => `${prevNodeId}${pkgId}:`, ':/:', parts))
    .map(nodeId => tree[nodeId].pkg.name)
    .join(' > ')
}

type ParentRefs = {
  [name: string]: ParentRef
}

type ParentRef = {
  version: string,
  depth: number,
  // this is null only for already installed top dependencies
  nodeId?: string,
}

function toPkgByName (nodes: {alias: string, node: TreeNode}[]): ParentRefs {
  const pkgsByName: ParentRefs = {}
  for (const node of nodes) {
    pkgsByName[node.alias] = {
      version: node.node.pkg.version,
      nodeId: node.node.nodeId,
      depth: node.node.depth,
    }
  }
  return pkgsByName
}

function createPeersFolderName(peers: InstalledPackage[]) {
  return peers.map(peer => `${peer.name.replace('/', '!')}@${peer.version}`).sort().join('+')
}

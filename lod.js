import * as THREE from 'three';
// import {scene, camera} from './renderer.js';
import {defaultChunkSize} from './constants.js';
import {abortError} from './lock-manager.js';
import {makePromise} from './util.js';
// import dcWorkerManager from './dc-worker-manager.js';

const localVector = new THREE.Vector3();
// const localVector2 = new THREE.Vector3();
// const localVector3 = new THREE.Vector3();
// const localVector4 = new THREE.Vector3();
// const localVector5 = new THREE.Vector3();
// const localQuaternion = new THREE.Quaternion();
// const localMatrix = new THREE.Matrix4();

// const onesLodsArray = new Array(8).fill(1);

// const nop = () => {};

class Dominator extends EventTarget {
  constructor(base, onload) {
    super();

    this.base = base;
    this.onload = onload;
    this.oldChunks = [];
    this.newChunks = [];

    this.unlistens = [];
  }
  start() {
    const renderDatas = Array(this.newChunks.length);
    const _done = () => {
      this.onload(renderDatas);
    };

    if ( // if clearing old chunks
      this.oldChunks.length > 0 &&
      this.newChunks.length === 0
    ) {
      // delete immediately
      _done();
    } else { // else if not clearing old chunks
      let pendingWaits = 0;
      for (let i = 0; i < this.newChunks.length; i++) {
        const chunk = this.newChunks[i];
        if (chunk.dataRequest.renderData === undefined) {
          pendingWaits++;
          // console.log('pending waits add', pendingWaits);
          const onload = e => {
            const {renderData} = e.data;
            renderDatas[i] = renderData;

            if (--pendingWaits === 0) {
              _done();
            }
          };
          chunk.addEventListener('load', onload);
          this.unlistens.push(() => {
            chunk.removeEventListener('load', onload);
          });
        } else {
          renderDatas[i] = chunk.dataRequest.renderData;
        }
      }
    }
  }
  cancel() {
    for (const unlisten of this.unlistens) {
      unlisten();
    }
  }
}

class OctreeNode extends EventTarget {
  constructor(min = new THREE.Vector3(), lod = 1, isLeaf = true, lodArray = new Int32Array(8).fill(-1)) {
    super();
    
    this.min = min;
    this.lod = lod;
    this.isLeaf = isLeaf;
    this.lodArray = lodArray;

    this.children = Array(8).fill(null);
  }
  containsPoint(p) {
    return p.x >= this.min.x && p.x < this.min.x + this.lod &&
      p.y >= this.min.y && p.y < this.min.y + this.lod &&
      p.z >= this.min.z && p.z < this.min.z + this.lod;
  }
  containsNode(node) {
    return this.containsPoint(node.min);
  }
  equalsNode(p) {
    return p.min.x === this.min.x && p.min.y === this.min.y && p.min.z === this.min.z;
  }
  equalsNodeLod(p) {
    return this.equalsNode(p) &&
      p.lodArray.every((lod, i) => lod === this.lodArray[i]);
  }
  intersectsNode(p) {
    return this.containsNode(p) || p.containsNode(this);
  }
  destroy() {
    this.dispatchEvent(new MessageEvent('destroy'));
  }
}
/* const tempUint32Array = new Uint32Array(1);
const _toUint32 = value => {
  tempUint32Array[0] = value;
  return tempUint32Array[0];
} */
const _octreeNodeMinHash = (min, lod) => `${min.x},${min.y},${min.z}:${lod}`;
const _getLeafNodeFromPoint = (leafNodes, p) => leafNodes.find(node => node.containsPoint(p));
const constructOctreeForLeaf = (position, lod1Range, maxLod) => {
  const nodeMap = new Map();
  
  const _getNode = (min, lod) => {
    const hash = _octreeNodeMinHash(min, lod);
    return nodeMap.get(hash);
  };
  const _createNode = (min, lod, isLeaf = lod === 1) => {
    const node = new OctreeNode(min, lod, isLeaf);
    const hash = _octreeNodeMinHash(min, lod);
    if (nodeMap.has(hash)) {
      throw new Error(`Node already exists: ${hash}`);
    }
    nodeMap.set(hash, node);
    return node;
  };
  const _getOrCreateNode = (min, lod) => _getNode(min, lod) ?? _createNode(min, lod);
  const _ensureChildren = parentNode => {
    const lodMin = parentNode.min;
    const lod = parentNode.lod;
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dz = 0; dz < 2; dz++) {
           const childIndex = dx + 2 * (dy + 2 * dz);
           if (parentNode.children[childIndex] === null) {
              parentNode.children[childIndex] = _createNode(
                lodMin.clone().add(
                  new THREE.Vector3(dx, dy, dz).multiplyScalar(lod / 2)
                ),
                lod / 2,
                true
              );
              parentNode.children[childIndex].parent = parentNode;
           }
        }
      }
    }
  };
  const _constructTreeUpwards = leafPosition => {
    let rootNode = _getOrCreateNode(leafPosition, 1);
    for (let lod = 2; lod <= maxLod; lod *= 2) {
      const lodMin = rootNode.min.clone();
      lodMin.x = Math.floor(lodMin.x / lod) * lod;
      lodMin.y = Math.floor(lodMin.y / lod) * lod;
      lodMin.z = Math.floor(lodMin.z / lod) * lod;

      const lodCenter = lodMin.clone().addScalar(lod / 2);
      const childIndex = (rootNode.min.x < lodCenter.x ? 0 : 1) +
        (rootNode.min.y < lodCenter.y ? 0 : 2) +
        (rootNode.min.z < lodCenter.z ? 0 : 4);

      const parentNode = _getOrCreateNode(lodMin, lod);
      parentNode.isLeaf = false;
      if (parentNode.children[childIndex] === null) { // children not set yet
        parentNode.children[childIndex] = rootNode;
        _ensureChildren(parentNode);
      }
      rootNode = parentNode;
    }
    return rootNode;
  };

  // sample base leaf nodes to generate octree upwards
  const rangeMin = position.clone()
    .sub(new THREE.Vector3(lod1Range, lod1Range, lod1Range));
  const rangeMax = position.clone()
    .add(new THREE.Vector3(lod1Range, lod1Range, lod1Range));
  for (let dx = rangeMin.x; dx <= rangeMax.x; dx++) {
    for (let dy = rangeMin.y; dy <= rangeMax.y; dy++) {
      for (let dz = rangeMin.z; dz <= rangeMax.z; dz++) {
        const leafPosition = new THREE.Vector3(dx, dy, dz);
        leafPosition.x = Math.floor(leafPosition.x);
        leafPosition.y = Math.floor(leafPosition.y);
        leafPosition.z = Math.floor(leafPosition.z);
        _constructTreeUpwards(leafPosition);
      }
    }
  }

  const rootNodes = [];
  for (const node of nodeMap.values()) {
    if (node.lod === maxLod) {
      rootNodes.push(node);
    }
  }

  const lod1Nodes = [];
  for (const node of nodeMap.values()) {
    if (node.lod === 1) {
      lod1Nodes.push(node);
    }
  }

  // sanity check lod1Nodes for duplicates
  {
    const lod1NodeMap = new Map();
    for (const node of lod1Nodes) {
      const hash = _octreeNodeMinHash(node.min, node.lod);
      if (lod1NodeMap.has(hash)) {
        throw new Error(`Duplicate lod1 node: ${hash}`);
      }
      lod1NodeMap.set(hash, node);
    }
  }

  const leafNodes = [];
  for (const node of nodeMap.values()) {
    if (node.isLeaf) {
      leafNodes.push(node);
    }
  }

  // sanity check that no leaf node contains another leaf node
  for (const leafNode of leafNodes) {
    for (const childNode of leafNode.children) {
      if (childNode?.isLeaf) {
        throw new Error(`Leaf node contains another leaf node 1: ${leafNode.min.toArray().join(',')}`);
      }
    }
    for (const leafNode2 of leafNodes) {
      if (leafNode !== leafNode2 && leafNode.containsNode(leafNode2)) {
        throw new Error(`Leaf node contains another leaf node 2: ${leafNode.min.toArray().join(',')}`);
      }
    }
  }

  // assign lodArray for each node based on the minimum lod of the target point in the world
  // vm::ivec3(0, 0, 0),
  // vm::ivec3(1, 0, 0),
  // vm::ivec3(0, 0, 1),
  // vm::ivec3(1, 0, 1),
  // vm::ivec3(0, 1, 0),
  // vm::ivec3(1, 1, 0),
  // vm::ivec3(0, 1, 1),
  // vm::ivec3(1, 1, 1),
  for (const node of nodeMap.values()) {
    node.lodArray = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 1),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 1, 0),
      new THREE.Vector3(0, 1, 1),
      new THREE.Vector3(1, 1, 1),
    ].map(offset => {
      const containingLeafNode = _getLeafNodeFromPoint(leafNodes, node.min.clone().add(offset.clone().multiplyScalar(node.lod)));
      if (containingLeafNode) {
        return containingLeafNode.lod;
      } else {
        return node.lod;
      }
    });
  }

  return leafNodes;
};
const equalsNode = (a, b) => {
  return a.min.equals(b.min) && a.lod === b.lod;
};
const equalsNodeLod = (a, b) => {
  return equalsNode(a, b) && a.lodArray.every((lod, i) => lod === b.lodArray[i]);
};
const containsPoint = (a, p) => {
  return p.x >= a.min.x && p.x < a.min.x + a.lod &&
    p.y >= a.min.y && p.y < a.min.y + a.lod &&
    p.z >= a.min.z && p.z < a.min.z + a.lod;
};
/* const containsNode = (a, node) => {
  return containsPoint(a, node.min);
}; */
const findLeafNodeForPosition = (nodes, p) => {
  for (const node of nodes) {
    if (containsPoint(node, p)) {
      return node;
    }
  }
  return null;
};
const isNop = taskSpec => {
  // console.log('is nop', taskSpec);
  return taskSpec.newNodes.length === taskSpec.oldNodes.length && taskSpec.newNodes.every(newNode => {
    return taskSpec.oldNodes.some(oldNode => equalsNodeLod(oldNode, newNode));
  });
};
class Task extends EventTarget {
  constructor(id, maxLodNode, type, newNodes = [], oldNodes = []) {
    super();

    this.id = id;
    this.maxLodNode = maxLodNode;
    this.type = type;
    this.newNodes = newNodes;
    this.oldNodes = oldNodes;

    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
  }
  /* equals(t) {
    return this.newNodes.length === this.oldNodes.length && this.newNodes.every(node => {
      return t.newNodes.some(node2 => node.equalsNode(node2));
    }) && this.oldNodes.every(node => {
      return t.oldNodes.some(node2 => node.equalsNode(node2));
    });
  } */
  cancel() {
    this.abortController.abort(abortError);
  }
  /* isNop() {
    const task = this;
    return task.newNodes.length === task.oldNodes.length && task.newNodes.every(newNode => {
      return task.oldNodes.some(oldNode => equalsNode(oldNode, newNode));
    });
  } */
  commit() {
    this.dispatchEvent(new MessageEvent('finish'));
  }
  waitForLoad() {
    const p = makePromise();
    this.addEventListener('finish', () => {
      p.accept();
    }, {
      once: true,
    });
    return p;
  }
}
/* const diffLeafNodes = (newLeafNodes, oldLeafNodes) => {
  // map from min lod hash to task containing new nodes and old nodes
  const taskMap = new Map();

  const _getMaxLodNode = min => {
    const newLeafNode = _getLeafNodeFromPoint(newLeafNodes, min);
    const oldLeafNode = _getLeafNodeFromPoint(oldLeafNodes, min);
    if (newLeafNode && oldLeafNode) {
      return newLeafNode.lod > oldLeafNode.lod ? newLeafNode : oldLeafNode;
    } else if (newLeafNode) {
      return newLeafNode;
    } else {
      return oldLeafNode;
    }
  };
  for (const newNode of newLeafNodes) {
    const maxLodNode = _getMaxLodNode(newNode.min);
    const hash = _octreeNodeMinHash(maxLodNode.min, maxLodNode.lod);
    let task = taskMap.get(hash);
    if (!task) {
      task = new Task(maxLodNode);
      taskMap.set(hash, task);
    }
    task.newNodes.push(newNode);
  }
  for (const oldNode of oldLeafNodes) {
    const maxLodNode = _getMaxLodNode(oldNode.min);
    const hash = _octreeNodeMinHash(maxLodNode.min, maxLodNode.lod);
    let task = taskMap.get(hash);
    if (!task) {
      task = new Task(maxLodNode);
      taskMap.set(hash, task);
    }
    task.oldNodes.push(oldNode);
  }

  let tasks = Array.from(taskMap.values());
  return tasks;
};
// sort tasks by distance to world position of the central max lod node
const sortTasks = (tasks, worldPosition) => {
  const taskDistances = tasks.map(task => {
    const distance = localVector2.copy(task.maxLodNode.min)
      .add(localVector3.setScalar(task.maxLodNode.lod / 2))
      .distanceToSquared(worldPosition);
    return {
      task,
      distance,
    };
  });
  taskDistances.sort((a, b) => {
    return a.distance - b.distance;
  });
  return taskDistances.map(taskDistance => taskDistance.task);
}; */

class DataRequest {
  constructor(node) {
    this.node = node;

    this.abortController = new AbortController();
    this.signal = this.abortController.signal;

    this.loadPromise = makePromise();

    this.node.dataRequest = this;

    this.renderData = undefined;
    this.loadPromise.then(renderData => {
      this.renderData = renderData;
      this.node.dispatchEvent(new MessageEvent('load', {
        data: {
          renderData,
        },
      }));
    }, err => {
      const renderData = null;
      this.renderData = renderData;
      this.node.dispatchEvent(new MessageEvent('load', {
        data: {
          renderData,
        },
      }));
    });
  }
  replaceNode(node) {
    this.node = node;
    this.node.dataRequest = this;
  }
  cancel() {
    // console.log('cancel data request');
    this.abortController.abort(abortError);
  }
  waitForLoad() {
    return this.loadPromise;
  }
  waitUntil(p) {
    p.then(result => {
      this.loadPromise.accept(result);
    }).catch(err => {
      this.loadPromise.reject(err);
    });
  }
}

/* const TrackerTaskTypes = {
  ADD: 1,
  REMOVE: 2,
  OUTRANGE: 3,
}; */
/* const updateChunks = (oldChunks, tasks) => {
  const newChunks = oldChunks.slice();
  
  for (const task of tasks) {
    if (!isNop(task) && task.type != TrackerTaskTypes.OUTRANGE) {
      let {newNodes, oldNodes} = task;
      for (const oldNode of oldNodes) {
        const index = newChunks.findIndex(chunk => equalsNode(chunk, oldNode));
        if (index !== -1) {
          newChunks.splice(index, 1);
        } else {
          debugger;
        }
      }
      newChunks.push(...newNodes);
    }
  }

  // console.log('update chunks', oldChunks.length, tasks.length, newChunks.length);

  return newChunks;
}; */

/*
note: the nunber of lods at each level can be computed with this function:

  getNumLodsAtLevel = n => n === 0 ? 1 : (2*n+1)**2-(getNumLodsAtLevel(n-1));

the total number of chunks with 3 lods is:
  > getNumLodsAtLevel(0) + getNumLodsAtLevel(1) + getNumLodsAtLevel(2) + getNumLodsAtLevel(3)
  < 58

---

the view range for a chunk size and given number of lods is:

  // 0, 1, 2 are our lods
  getViewRangeInternal = n => (n === 0 ? 1 : (3*getViewRangeInternal(n-1)));
  getViewRange = (n, chunkSize) => getViewRangeInternal(n) * chunkSize / 2;

for a chunkSize of 30, we have the view distance of each lod:

  getViewRange(1, 30) = 45 // LOD 0
  getViewRange(2, 30) = 135 // LOD 1
  getViewRange(3, 30) = 405 // LOD 2
---

for a million tris budget, the tris per chunk is:
  1,000,000 tri / 58 chunks rendered = 17241.379310344827586206896551724 tri

for a chunk size of 30 meters, the density of tris per uniform meters cubic is:
  > 17241.379310344827586206896551724 tri / (30**3 meters)
  < 0.6385696040868454 tri/m^3

per meters squared, it's 19.157088122605362 tri/m^2

---

using these results

- the tri budget can be scaled linearly with the results
- the chunk size can be changed to increase the view distance while decreasing the density, while keeping the tri budget the same
*/
export class LodChunk extends THREE.Vector3 {
  constructor(x, y, z, lod, lodArray) {
    
    super(x, y, z);
    this.lod = lod;
    this.lodArray = lodArray;

    this.name = `chunk:${this.x}:${this.y}:${this.z}`;
    this.binding = null;
    this.items = [];
    this.physicsObjects = [];
  }
  lodEquals(chunk) {
    return this.lod === chunk.lod &&
      this.lodArray.length === chunk.lodArray.length && this.lodArray.every((lod, i) => lod === chunk.lodArray[i]);
  }
  containsPoint(p) {
    return p.x >= this.x && p.x < this.x + this.lod &&
      p.y >= this.y && p.y < this.y + this.lod &&
      p.z >= this.z && p.z < this.z + this.lod;
  }
}
export class LodChunkTracker extends EventTarget {
  constructor({
    chunkSize = defaultChunkSize,
    lods = 1,
    minLodRange = 2,
    trackY = false,
    dcWorkerManager = null,
    debug = false,
  } = {}) {
    super();

    // console.log('got lod chunk tracker', new Error().stack);

    this.chunkSize = chunkSize;
    this.lods = lods;
    this.minLodRange = minLodRange;
    this.trackY = trackY;
    this.dcWorkerManager = dcWorkerManager;

    this.dcTracker = null;
    this.chunks = [];
    this.displayChunks = []; // for debug mesh
    this.renderedChunks = new Map(); // hash -> OctreeNode
    this.dataRequests = new Map(); // hash -> DataRequest
    this.lastUpdateCoord = new THREE.Vector3(NaN, NaN, NaN);

    this.dominators = new Map(); // hash -> OctreeNode

    if (debug) {
      const maxChunks = 4096;
      const instancedCubeGeometry = new THREE.InstancedBufferGeometry();
      {
        const cubeGeometry = new THREE.BoxBufferGeometry(1, 1, 1)
          .translate(0.5, 0.5, 0.5);
        for (const k in cubeGeometry.attributes) {
          instancedCubeGeometry.setAttribute(k, cubeGeometry.attributes[k]);
        }
        instancedCubeGeometry.setIndex(cubeGeometry.index);
      }
      const redMaterial = new THREE.MeshBasicMaterial({
        color: 0xFFFFFF,
        // transparent: true,
        // opacity: 0.1,
        wireframe: true,
      });
      const debugMesh = new THREE.InstancedMesh(instancedCubeGeometry, redMaterial, maxChunks);
      debugMesh.count = 0;
      debugMesh.frustumCulled = false;
      this.debugMesh = debugMesh;

      {
        const localVector = new THREE.Vector3();
        // const localVector2 = new THREE.Vector3();
        const localVector3 = new THREE.Vector3();
        const localQuaternion = new THREE.Quaternion();
        const localMatrix = new THREE.Matrix4();
        const localColor = new THREE.Color();

        const _getChunkColorHex = chunk => {
          const {lod} = chunk;
          if (lod === 1) {
            return 0xFF0000;
          } else if (lod === 2) {
            return 0x00FF00;
          } else if (lod === 4) {
            return 0x0000FF;
          } else {
            return 0x0;
          }
        };
        const _flushChunks = () => {
          debugMesh.count = 0;
          for (let i = 0; i < this.displayChunks.length; i++) {
            const chunk = this.displayChunks[i];
            localMatrix.compose(
              localVector.copy(chunk.min)
                .multiplyScalar(this.chunkSize),
                // .add(localVector2.set(0, -60, 0)),
              localQuaternion.identity(),
              localVector3.set(1, 1, 1)
                .multiplyScalar(chunk.lod * this.chunkSize * 0.9)
            );
            localColor.setHex(_getChunkColorHex(chunk));
            // console.log('got chunk', chunk, localMatrix.toArray().join(','), _getChunkColorHex(chunk));
            debugMesh.setMatrixAt(debugMesh.count, localMatrix);
            debugMesh.setColorAt(debugMesh.count, localColor);
            debugMesh.count++;
          }
          debugMesh.instanceMatrix.needsUpdate = true;
          debugMesh.instanceColor && (debugMesh.instanceColor.needsUpdate = true);
        };
        this.addEventListener('update', e => {
          _flushChunks();
        });
      }

      this.isUpdating = false;
      this.queuedPosition = null;
    }

    this.lastOctreeLeafNodes = [];
    this.liveTasks = [];
  }
  #getCurrentCoord(position, target) {
    const cx = Math.floor(position.x / this.chunkSize);
    const cy = this.trackY ? Math.floor(position.y / this.chunkSize) : 0;
    const cz = Math.floor(position.z / this.chunkSize);
    return target.set(cx, cy, cz);
  }
  emitChunkDestroy(chunk) {
    // const hash = chunk.min.toArray().join(',') + ':' + chunk.lod; // _octreeNodeMinHash(chunk.min, chunk.lod);
    this.dispatchEvent(new MessageEvent('destroy', {
      data: {
        node: chunk,
      }
    }));
  }
  listenForChunkDestroy(chunk, fn) {
    // const hash = chunk.min.toArray().join(',') + ':' + chunk.lod; // _octreeNodeMinHash(chunk.min, chunk.lod);
    const destroy = e => {
      if (e.data.node.min.equals(chunk)) {
        fn(e);
        this.removeEventListener('destroy', destroy);
      }
    };
    this.addEventListener('destroy', destroy);
  }
  /* updateCoord(currentCoord) {
    const octreeLeafNodes = constructOctreeForLeaf(currentCoord, this.minLodRange, 2 ** (this.lods - 1));

    let tasks = diffLeafNodes(
      octreeLeafNodes,
      this.lastOctreeLeafNodes,
    );

    const {
      chunks,
      extraTasks,
    } = updateChunks(this.chunks, tasks);
    this.chunks = chunks;
    tasks.push(...extraTasks);

    sortTasks(tasks, camera.position);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (!task.isNop()) {
        const overlappingTasks = this.liveTasks.filter(lastTask => task.maxLodNode.containsNode(lastTask.maxLodNode));
        for (const oldTask of overlappingTasks) {
          oldTask.cancel();
          this.liveTasks.splice(this.liveTasks.indexOf(oldTask), 1);
        }
        this.liveTasks.push(task);
      }
    }

    for (const task of tasks) {
      if (!task.isNop()) {
        this.dispatchEvent(new MessageEvent('chunkrelod', {
          data: {
            task,
          },
        }));
      }
    }

    this.lastOctreeLeafNodes = octreeLeafNodes;

    this.dispatchEvent(new MessageEvent('update'));
  } */
  async waitForLoad() {
    // console.log('wait for live tasks 1', this.liveTasks.length);
    await Promise.all(this.liveTasks.map(task => task.waitForLoad()));
    // console.log('wait for live tasks 2', this.liveTasks.length);
  }
  /* update(position) {
    const currentCoord = this.#getCurrentCoord(position, localVector).clone();

    // if we moved across a chunk boundary, update needed chunks
    if (!currentCoord.equals(this.lastUpdateCoord)) {
      this.updateCoord(currentCoord);
      this.lastUpdateCoord.copy(currentCoord);
    }
  } */
  async updateInternal(position) {
    if (!this.dcTracker) {
      this.dcTracker = await this.dcWorkerManager.createTracker(this.lods, this.minLodRange, this.trackY);
    }

    const trackerUpdateSpec = await this.dcWorkerManager.trackerUpdate(this.dcTracker, position);
    let {
      // currentCoord,
      // oldTasks,
      // newTasks,
      leafNodes,
    } = trackerUpdateSpec;

    const _parseNode = (nodeSpec) => {
      const {min, size: lod, isLeaf, lodArray} = nodeSpec;
      return new OctreeNode(
        new THREE.Vector3().fromArray(min),
        lod,
        isLeaf,
        lodArray
      );
    };
    /* const _parseTask = (taskSpec) => {
      // console.log('parse task', taskSpec);
      const {id, type} = taskSpec;
      const newNodes = taskSpec.newNodes.map(newNode => _parseNode(newNode));
      const oldNodes = taskSpec.oldNodes.map(oldNode => _parseNode(oldNode));
      return new Task(
        id,
        _parseNode(taskSpec),
        type,
        newNodes,
        oldNodes,
      );
    }; */
    // oldTasks = oldTasks.map(_parseTask);
    // newTasks = newTasks.map(_parseTask);
    /* if (leafNodes.length === 0) {
      debugger;
    } */
    leafNodes = leafNodes.map(_parseNode);

    // debug mesh
    this.displayChunks = leafNodes;

    // data requests
    {
      // cancel old data requests
      const oldDataRequests = Array.from(this.dataRequests.entries());
      for (const [hash, oldDataRequest] of oldDataRequests) {
        const matchingLeafNode = leafNodes.find(leafNode => {
          return equalsNodeLod(leafNode, oldDataRequest.node)
        });
        if (matchingLeafNode) {
          // keep the data request
          oldDataRequest.replaceNode(matchingLeafNode);
        } else {
          // cancel the data request
          oldDataRequest.cancel();
          // forget the data request
          this.dataRequests.delete(hash);
        }
      }

      // add new data requests
      for (const chunk of leafNodes) {
        const hash = chunk.min.toArray().join(',') + ':' + chunk.lod;
        if (!this.dataRequests.has(hash)) {
          const dataRequest = new DataRequest(chunk);
          const {signal} = dataRequest;
          let waited = false;

          const chunkDataRequestEvent = new MessageEvent('chunkdatarequest', {
            data: {
              chunk,
              waitUntil(promise) {
                /* const stack = new Error().stack;
                promise.then(r => {
                  if (r === null) {
                    console.log('promise stack', stack);
                    debugger;
                  }
                }); */
                dataRequest.waitUntil(promise);
                waited = true;
              },
              signal,
            },
          });
          this.dispatchEvent(chunkDataRequestEvent);

          if (!waited) {
            dataRequest.waitUntil(Promise.resolve({
              unwaited: true,
            }));
          }
          this.dataRequests.set(hash, dataRequest);
        }
      }
    }

    // compute dominators. a dominator is a chunk lod that contains a a transform from old chunks to new chunks.
    for (const dominator of this.dominators.values()) {
      dominator.cancel();
    }
    this.dominators.clear();
    {
      const oldRenderedChunks = Array.from(this.renderedChunks.values());
      const newRenderedChunks = Array.from(this.dataRequests.values()).map(dataRequest => dataRequest.node);
      const addChunk = (chunk, isNew) => {
        const oldLeafNode = findLeafNodeForPosition(oldRenderedChunks, chunk.min);
        const newLeafNode = findLeafNodeForPosition(newRenderedChunks, chunk.min);
        let maxLodChunk;
        if (oldLeafNode && newLeafNode) {
          maxLodChunk = oldLeafNode.lod > newLeafNode.lod ? oldLeafNode : newLeafNode;
        } else if (oldLeafNode) {
          maxLodChunk = oldLeafNode;
        } else if (newLeafNode) {
          maxLodChunk = newLeafNode;
        } else {
          throw new Error('no chunk match in any leaf set');
        }

        const maxLodHash = maxLodChunk.min.toArray().join(',') + ':' + maxLodChunk.lod;
        let dominator = this.dominators.get(maxLodHash);
        if (!dominator) {
          dominator = new Dominator(maxLodChunk, renderDatas => {
            for (const oldChunk of dominator.oldChunks) {
              const chunkRemoveEvent = new MessageEvent('chunkremove', {
                data: {
                  chunk: oldChunk,
                },
              });
              this.dispatchEvent(chunkRemoveEvent);
   
              const hash = oldChunk.min.toArray().join(',') + ':' + oldChunk.lod;
              this.renderedChunks.delete(hash);
            }
            for (let i = 0; i < dominator.newChunks.length; i++) {
              const newChunk = dominator.newChunks[i];
              const renderData = renderDatas[i];
              // console.log('add chunk', newChunk);

              const chunkAddEvent = new MessageEvent('chunkadd', {
                data: {
                  renderData,
                  chunk: newChunk,
                },
              });
              this.dispatchEvent(chunkAddEvent);

              const hash = newChunk.min.toArray().join(',') + ':' + newChunk.lod;
              this.renderedChunks.set(hash, newChunk);
            }
          });
          this.dominators.set(maxLodHash, dominator);
        }
        if (isNew) {
          dominator.newChunks.push(chunk);
        } else {
          dominator.oldChunks.push(chunk);
        }
      };
      for (const chunk of oldRenderedChunks) {
        addChunk(chunk, false);
      }
      for (const chunk of newRenderedChunks) {
        addChunk(chunk, true);
      }
      for (const dominator of this.dominators.values()) {
        dominator.start();
      }
      // window.dominators = this.dominators;
    }

    this.dispatchEvent(new MessageEvent('update'));
  }
  update(position) {
    // console.log('position update 0', position.toArray().join(','), this.isUpdating);
    
    if (!this.isUpdating) {
      let currentCoord = this.#getCurrentCoord(position, localVector).clone();
      // console.log('check equals', position.toArray(), this.lastUpdateCoord.toArray(), currentCoord.toArray(), this.lastUpdateCoord.equals(currentCoord));
      if (!this.lastUpdateCoord.equals(currentCoord)) {
        // console.log('position update 1', currentCoord.toArray().join(','));
        
        (async () => {
          this.isUpdating = true;

          await this.updateInternal(position);

          // console.log('position update 2', currentCoord.toArray().join(','));

          this.isUpdating = false;

          if (this.queuedPosition) {
            const {queuedPosition} = this;
            this.queuedPosition = null;

            // console.log('recurse on queued position', queuedPosition.toArray());
            this.update(queuedPosition);
          }
        })();

        this.lastUpdateCoord.copy(currentCoord);
      }
    } else {
      this.queuedPosition = position.clone();
    }
  }
  destroy() {
    throw new Error('not implemented');

    for (const chunk of this.chunks) {
      const task = new Task(chunk);
      task.oldNodes.push(chunk);
      
      this.dispatchEvent(new MessageEvent('chunkrelod', {
        data: {
          task,
        },
      }));
    }
    this.chunks.length = 0;
  }
}
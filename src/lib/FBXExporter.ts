/* eslint-disable */
// @ts-nocheck
// Vendored from https://github.com/needle-tools/three-fbx-exporter
import {
	BufferGeometry,
	Material,
	Mesh,
	Object3D,
	Matrix4,
	Vector3,
	Euler,
	Quaternion,
	Color,
	Texture,
	DataTexture,
	RGBAFormat,
	SRGBColorSpace,
	ClampToEdgeWrapping,
	RepeatWrapping,
	MirroredRepeatWrapping,
	MathUtils,
	MeshStandardMaterial,
	MeshPhysicalMaterial,
	DoubleSide
} from 'three';
import { Zip, ZipPassThrough, strToU8, zlibSync } from 'fflate';

const FBX_FOOTER_ID = Uint8Array.from([
	0xfa, 0xbc, 0xab, 0x09,
	0xd0, 0xc8, 0xd4, 0x66,
	0xb1, 0x76, 0xfb, 0x83,
	0x1c, 0xf7, 0x26, 0x7e
]);

const FBX_FINAL_MAGIC = Uint8Array.from([
	0xf8, 0x5a, 0x8c, 0x6a,
	0xde, 0xf5, 0xd9, 0x7e,
	0xec, 0xe9, 0x0c, 0xe3,
	0x75, 0x8f, 0x29, 0x0b
]);

const FBX_CREATION_TIME = '1970-01-01 10:00:00:000';
const FBX_FILE_ID = Uint8Array.from([
	0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2,
	0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1
]);

type FBXExportTarget = 'Default' | 'Horizon Worlds';
type FBXExportFormat = 'ascii' | 'binary';

interface FBXExportOptions {
	target?: FBXExportTarget;
	binary?: boolean;
	embedTextures?: boolean;
}

interface FBXExportResult {
	target: FBXExportTarget;
	format: FBXExportFormat;
	fbxFileName: string;
	fbxData: string | ArrayBuffer;
	files: Record<string, Uint8Array>;
	textures: Texture[];
	zipData: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.from([ 137, 80, 78, 71, 13, 10, 26, 10 ]);

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for ( let i = 0; i < 256; i ++ ) {
		let crc = i;
		for ( let j = 0; j < 8; j ++ ) {
			crc = ( crc & 1 ) ? ( 0xedb88320 ^ ( crc >>> 1 ) ) : ( crc >>> 1 );
		}
		table[ i ] = crc >>> 0;
	}
	return table;
})();

function concatUint8Arrays( chunks: Uint8Array[] ): Uint8Array {
	const totalLength = chunks.reduce( ( sum, chunk ) => sum + chunk.length, 0 );
	const output = new Uint8Array( totalLength );
	let offset = 0;
	for ( const chunk of chunks ) {
		output.set( chunk, offset );
		offset += chunk.length;
	}
	return output;
}

function writeUint32BE( target: Uint8Array, offset: number, value: number ): void {
	target[ offset ] = ( value >>> 24 ) & 0xff;
	target[ offset + 1 ] = ( value >>> 16 ) & 0xff;
	target[ offset + 2 ] = ( value >>> 8 ) & 0xff;
	target[ offset + 3 ] = value & 0xff;
}

function crc32( data: Uint8Array ): number {
	let crc = 0xffffffff;
	for ( let i = 0; i < data.length; i ++ ) {
		crc = CRC32_TABLE[ ( crc ^ data[ i ] ) & 0xff ] ^ ( crc >>> 8 );
	}
	return ( crc ^ 0xffffffff ) >>> 0;
}

function createPngChunk( type: string, data: Uint8Array ): Uint8Array {
	const typeBytes = strToU8( type );
	const lengthBytes = new Uint8Array( 4 );
	writeUint32BE( lengthBytes, 0, data.length );

	const crcBytes = new Uint8Array( 4 );
	writeUint32BE( crcBytes, 0, crc32( concatUint8Arrays( [ typeBytes, data ] ) ) );

	return concatUint8Arrays( [ lengthBytes, typeBytes, data, crcBytes ] );
}

function encodePngRgba( rgba: Uint8Array, width: number, height: number ): Uint8Array {
	const stride = width * 4;
	const filtered = new Uint8Array( height * ( stride + 1 ) );
	for ( let y = 0; y < height; y ++ ) {
		const sourceOffset = y * stride;
		const targetOffset = y * ( stride + 1 );
		filtered[ targetOffset ] = 0;
		filtered.set( rgba.subarray( sourceOffset, sourceOffset + stride ), targetOffset + 1 );
	}

	const ihdr = new Uint8Array( 13 );
	writeUint32BE( ihdr, 0, width );
	writeUint32BE( ihdr, 4, height );
	ihdr[ 8 ] = 8;
	ihdr[ 9 ] = 6;
	ihdr[ 10 ] = 0;
	ihdr[ 11 ] = 0;
	ihdr[ 12 ] = 0;

	const idat = zlibSync( filtered, { level: 9 } );

	return concatUint8Arrays( [
		PNG_SIGNATURE,
		createPngChunk( 'IHDR', ihdr ),
		createPngChunk( 'IDAT', idat ),
		createPngChunk( 'IEND', new Uint8Array( 0 ) )
	] );
}

function decodeBase64Bytes( base64Data: string ): Uint8Array {
	if ( typeof atob === 'function' ) {
		const binary = atob( base64Data );
		const bytes = new Uint8Array( binary.length );
		for ( let i = 0; i < binary.length; i ++ ) {
			bytes[ i ] = binary.charCodeAt( i );
		}
		return bytes;
	}

	const bufferCtor = ( globalThis as any ).Buffer;
	if ( bufferCtor ) {
		return new Uint8Array( bufferCtor.from( base64Data, 'base64' ) );
	}

	throw new Error( 'No base64 decoder available in this runtime.' );
}

function encodeBase64Bytes( data: Uint8Array ): string {
	const bufferCtor = ( globalThis as any ).Buffer;
	if ( bufferCtor ) {
		return bufferCtor.from( data ).toString( 'base64' );
	}

	if ( typeof btoa === 'function' ) {
		let binary = '';
		for ( let i = 0; i < data.length; i ++ ) {
			binary += String.fromCharCode( data[ i ] );
		}
		return btoa( binary );
	}

	throw new Error( 'No base64 encoder available in this runtime.' );
}

function ensureUint8Array( data: Uint8Array ): Uint8Array {
	return new Uint8Array( data );
}

function createZipData( files: Record<string, Uint8Array> ): Promise<Uint8Array> {
	return new Promise<Uint8Array>( ( resolve, reject ) => {
		const chunks: Uint8Array[] = [];
		const archive = new Zip( ( error, chunk, final ) => {
			if ( error ) {
				reject( error );
				return;
			}

			if ( chunk ) {
				chunks.push( chunk );
			}

			if ( final ) {
				resolve( concatUint8Arrays( chunks ) );
			}
		} );

		try {
			for ( const [ fileName, contents ] of Object.entries( files ) ) {
				const entry = new ZipPassThrough( fileName );
				archive.add( entry );
				entry.push( ensureUint8Array( contents ), true );
			}
			archive.end();
		} catch ( error ) {
			reject( error );
		}
	} );
}

/**
 * A exporter for the FBX format.
 *
 * Supports basic hierarchies, meshes, and materials.
 *
 * @class FBXExporter
 */
class FBXExporter {

	version: number;
	idCounter: number;
	objects: any;
	connections: Array<{ childId: number; parentId: number; type: string; property?: string | null }>;
	globalSettings: any;
	textures: Texture[];
	embedTextures: boolean;
	warningKeys: Set<string>;

	/**
	 * Helper for indentation (tabs per level)
	 */
	indent( level: number ): string {
		return '\t'.repeat(level);
	}

	/**
	 * Constructs a new FBX exporter.
	 */
	constructor() {
		this.version = 7400; // FBX version 7.4
		this.idCounter = 1000; // Starting ID for objects
		this.objects = {};
		this.connections = [];
		this.textures = [];
		this.embedTextures = false; // Default to not embedding textures
		this.warningKeys = new Set();
		this.globalSettings = [
			{ name: 'UpAxis', type: 'int', type2: 'Integer', value: 1 },
			{ name: 'UpAxisSign', type: 'int', type2: 'Integer', value: 1 },
			{ name: 'FrontAxis', type: 'int', type2: 'Integer', value: 2 },
			{ name: 'FrontAxisSign', type: 'int', type2: 'Integer', value: 1 },
			{ name: 'CoordAxis', type: 'int', type2: 'Integer', value: 0 },
			{ name: 'CoordAxisSign', type: 'int', type2: 'Integer', value: 1 },
			{ name: 'OriginalUpAxis', type: 'int', type2: 'Integer', value: 1 },
			{ name: 'OriginalUpAxisSign', type: 'int', type2: 'Integer', value: 1 },
			{ name: 'UnitScaleFactor', type: 'double', type2: 'Number', value: 1.0 },
			{ name: 'OriginalUnitScaleFactor', type: 'double', type2: 'Number', value: 1.0 },
			{ name: 'TimeSpanStart', type: 'KTime', type2: 'Time', value: 0 },
			{ name: 'TimeSpanStop', type: 'KTime', type2: 'Time', value: 0 },
			{ name: 'TimeMode', type: 'enum', type2: '', value: 0 },
			{ name: 'CustomFrameRate', type: 'double', type2: 'Number', value: 30.0001 }
		];
	}

	/**
	 * Exports the given object to FBX format.
	 *
	 * @param {Object3D} object - The object to export.
	 * @param {Object} [options] - Export options.
	 * @param {string} [options.target='Default'] - Export target ('Default' or 'Horizon Worlds').
	 * @param {boolean} [options.binary=false] - Export in binary format.
	 * @param {boolean} [options.embedTextures=false] - Whether to embed texture data in the FBX file.
	 * @return {Promise<FBXExportResult>} The exported FBX payloads and archive data.
	 */
	async export( object: Object3D, options: FBXExportOptions = {} ): Promise<FBXExportResult> {
		const { target = 'Default', binary = false, embedTextures = false } = options;
		const format: FBXExportFormat = binary ? 'binary' : 'ascii';
		const fbxFileName = 'model.fbx';

		this.reset();
		object.updateMatrixWorld?.( true );
		
		this.embedTextures = embedTextures;
		this.traverseObject( object, null );
		const fbxData = this.generateFBX( target, binary );
		const textures = this.collectTextures();
		const files = await this.createFiles( fbxFileName, fbxData, textures );
		const zipData = await createZipData( files );

		return {
			target,
			format,
			fbxFileName,
			fbxData,
			files,
			textures,
			zipData
		};
	}

	reset() {
		this.idCounter = 1000;
		this.objects = {
			Model: {},
			Geometry: {},
			Material: {},
			Texture: {},
			Video: {},
			NodeAttribute: {}
		};
		this.connections = [];
		this.textures = [];
		this.embedTextures = false; // Reset to default
		this.warningKeys.clear();
	}

	traverseObject( object, parentId ) {
		const objectId = this.getNextId();

		// Create Model node
		this.createModel( object, objectId );
		this.createNodeAttributeForObject( object, objectId );
		this.createLookAtTargetForObject( object, objectId );

		// Connect to parent
		if ( parentId !== null ) {
			this.addConnection( objectId, parentId, 'OO' );
		} else {
			// Top-level objects must be connected to the root (ID 0) for Blender and FBX SDK to import them
			this.addConnection( objectId, 0, 'OO' );
		}

		// Handle specific object types
		if ( object.isMesh ) {
			this.handleMesh( object, objectId );
		}

		// Recurse on children
		for ( const child of object.children ) {
			this.traverseObject( child, objectId );
		}
	}

	createModel( object, id ) {
		const hasNodeAttribute = object.isCamera || object.isLight;
		const model = {
			id: id,
			attrName: object.name && object.name.length > 0 ? object.name : 'Model',
			fbxClass: 'Model',
			attrType: this.getModelType( object ),
			Version: 232,
			Culling: 'CullingOff',
			Properties70: {
				P: this.createModelPropertyList(
					object.position.toArray(),
					this.getEulerRotation( object ),
					object.scale.toArray(),
					this.getRotationOrder( object ),
					object.visible,
					hasNodeAttribute ? 0 : -1
				)
			}
		};

		this.objects.Model[ id ] = model;
	}

	createModelPropertyList(
		position: number[],
		rotation: number[],
		scale: number[],
		rotationOrder: number,
		visible: boolean,
		defaultAttributeIndex = -1
	) {
		return [
			{ name: 'InheritType', type: 'enum', value: 1 },
			{ name: 'RotationOrder', type: 'enum', value: rotationOrder },
			{ name: 'DefaultAttributeIndex', type: 'int', label: 'Integer', value: defaultAttributeIndex },
			this.createTypedScalarProperty( 'Visibility', 'Visibility', visible ? 1 : 0, 'D', '', 'A' ),
			{ name: 'Visibility Inheritance', type: 'Visibility Inheritance', value: 1 },
			{ name: 'Lcl Translation', type: 'Lcl_Translation', value: position },
			{ name: 'Lcl Rotation', type: 'Lcl_Rotation', value: rotation },
			{ name: 'Lcl Scaling', type: 'Lcl_Scaling', value: scale }
		];
	}

	createTypedScalarProperty(
		name: string,
		type: string,
		value: number,
		encodingType: 'I' | 'D' | 'L',
		label = '',
		flag = ''
	) {
		return {
			propertyList: [ name, type, label, flag, { value, encodingType } ]
		};
	}

	createNodeAttributeForObject( object, modelId ) {
		if ( object.isCamera ) {
			const nodeAttributeId = this.getNextId();
			this.createCameraAttribute( object, nodeAttributeId );
			this.addConnection( nodeAttributeId, modelId, 'OO' );
			return;
		}

		if ( object.isLight ) {
			const nodeAttributeId = this.getNextId();
			this.createLightAttribute( object, nodeAttributeId );
			this.addConnection( nodeAttributeId, modelId, 'OO' );
		}
	}

	createLookAtTargetForObject( object, modelId ) {
		if ( ! object.isDirectionalLight && ! object.isSpotLight ) {
			return;
		}

		if ( ! object.target || typeof object.target.getWorldPosition !== 'function' ) {
			return;
		}

		object.target.updateMatrixWorld?.( true );
		const targetPosition = object.target.getWorldPosition( new Vector3() );
		const targetId = this.getNextId();
		const targetName = object.target.name && object.target.name.length > 0
			? object.target.name
			: `${object.name || 'Light'}_Target`;

		this.objects.Model[ targetId ] = {
			id: targetId,
			attrName: targetName,
			fbxClass: 'Model',
			attrType: 'Null',
			Version: 232,
			Culling: 'CullingOff',
			Properties70: {
				P: this.createModelPropertyList(
					targetPosition.toArray(),
					[ 0, 0, 0 ],
					[ 1, 1, 1 ],
					5,
					false,
					-1
				)
			}
		};

		this.objects.Model[ modelId ].Properties70.P.push( {
			name: 'LookAtProperty',
			type: 'object',
			label: '',
			value: ''
		} );
		this.addConnection( targetId, modelId, 'OP', 'LookAtProperty' );
	}

	createCameraAttribute( camera, id ) {
		const attrName = camera.name && camera.name.length > 0 ? camera.name : 'Camera';
		const filmWidth = typeof camera.getFilmWidth === 'function' ? camera.getFilmWidth() : 36;
		const filmHeight = typeof camera.getFilmHeight === 'function' ? camera.getFilmHeight() : 24;
		const aspect = this.getCameraAspect( camera );
		const focalLength = typeof camera.getFocalLength === 'function' ? camera.getFocalLength() : null;

		const properties = [
			{ name: 'CameraProjectionType', type: 'enum', value: camera.isOrthographicCamera ? 1 : 0 },
			{ name: 'AspectWidth', type: 'double', label: 'Number', value: aspect * 1000 },
			{ name: 'AspectHeight', type: 'double', label: 'Number', value: 1000 },
			{ name: 'AspectW', type: 'double', label: 'Number', value: aspect * 1000 },
			{ name: 'AspectH', type: 'double', label: 'Number', value: 1000 },
			{ name: 'NearPlane', type: 'double', label: 'Number', value: camera.near * 1000 },
			{ name: 'FarPlane', type: 'double', label: 'Number', value: camera.far * 1000 },
			{ name: 'FilmWidth', type: 'double', label: 'Number', value: filmWidth },
			{ name: 'FilmHeight', type: 'double', label: 'Number', value: filmHeight }
		];

		if ( camera.isPerspectiveCamera ) {
			properties.push( { name: 'FieldOfView', type: 'double', label: 'Number', value: camera.fov } );
		}

		if ( focalLength !== null && Number.isFinite( focalLength ) ) {
			properties.push( { name: 'FocalLength', type: 'double', label: 'Number', value: focalLength } );
		}

		if ( camera.isOrthographicCamera ) {
			properties.push( {
				name: 'OrthoZoom',
				type: 'double',
				label: 'Number',
				value: this.getCameraOrthoZoom( camera )
			} );
		}

		if ( camera.focus !== undefined ) {
			properties.push( { name: 'FocusDistance', type: 'double', label: 'Number', value: camera.focus } );
		}

		this.objects.NodeAttribute[ id ] = {
			id,
			attrName,
			fbxClass: 'NodeAttribute',
			attrType: 'Camera',
			Properties70: { P: properties }
		};
	}

	createLightAttribute( light, id ) {
		const attrName = light.name && light.name.length > 0 ? light.name : 'Light';
		const properties: any[] = [
			{ name: 'LightType', type: 'enum', value: this.getLightType( light ) },
			{ name: 'Color', type: 'ColorRGB', label: 'Color', value: light.color.toArray() },
			{ name: 'Intensity', type: 'double', label: 'Number', value: light.intensity * 100 },
			{ name: 'CastLightOnObject', type: 'bool', value: light.visible ? 1 : 0 },
			{ name: 'CastShadow', type: 'bool', value: light.castShadow ? 1 : 0 },
			{ name: 'CastShadows', type: 'bool', value: light.castShadow ? 1 : 0 }
		];

		if ( light.distance !== undefined ) {
			properties.push( { name: 'EnableFarAttenuation', type: 'bool', value: light.distance > 0 ? 1 : 0 } );
			if ( light.distance > 0 ) {
				properties.push( { name: 'FarAttenuationEnd', type: 'double', label: 'Number', value: light.distance } );
			}
		}

		if ( light.isSpotLight ) {
			const outerAngle = MathUtils.radToDeg( light.angle );
			const innerAngle = outerAngle * ( 1 - light.penumbra );
			properties.push( { name: 'OuterAngle', type: 'double', label: 'Number', value: outerAngle } );
			properties.push( { name: 'InnerAngle', type: 'double', label: 'Number', value: innerAngle } );
		}

		this.objects.NodeAttribute[ id ] = {
			id,
			attrName,
			fbxClass: 'NodeAttribute',
			attrType: 'Light',
			Properties70: { P: properties }
		};
	}

	getCameraAspect( camera ) {
		if ( Number.isFinite( camera.aspect ) && camera.aspect > 0 ) {
			return camera.aspect;
		}

		if (
			camera.left !== undefined &&
			camera.right !== undefined &&
			camera.top !== undefined &&
			camera.bottom !== undefined
		) {
			const width = camera.right - camera.left;
			const height = camera.top - camera.bottom;
			if ( height !== 0 ) {
				return Math.abs( width / height );
			}
		}

		return 1;
	}

	getCameraOrthoZoom( camera ) {
		const width = Math.abs( camera.right - camera.left );
		const height = Math.abs( camera.top - camera.bottom );
		const zoom = camera.zoom || 1;
		return Math.max( width, height ) / zoom;
	}

	getLightType( light ) {
		if ( light.isDirectionalLight ) return 1;
		if ( light.isSpotLight ) return 2;
		if ( light.isPointLight ) return 0;

		this.warnOnce(
			`unsupported-light-type:${light.type}`,
			`FBX export does not have a direct mapping for ${light.type}; exporting "${light.name || light.type}" as a PointLight.`
		);
		return 0;
	}

	getModelType( object ) {
		if ( object.isMesh ) return 'Mesh';
		if ( object.isLight ) return 'Light';
		if ( object.isCamera ) return 'Camera';
		return 'Null';
	}

		getUvAttributeNames( geometry: BufferGeometry ) {
			const attributeNames = Object.keys( geometry.attributes );
			return attributeNames
				.filter( name => name === 'uv' || /^uv\d+$/.test( name ) )
				.sort( ( a, b ) => {
					if ( a === 'uv' ) return -1;
					if ( b === 'uv' ) return 1;
					return parseInt( a.slice( 2 ), 10 ) - parseInt( b.slice( 2 ), 10 );
				} );
		}

		getEulerRotation( object ) {
			const euler = new Euler().setFromQuaternion( object.quaternion, object.rotation.order );
			return [ MathUtils.radToDeg( euler.x ), MathUtils.radToDeg( euler.y ), MathUtils.radToDeg( euler.z ) ];
		}

		getRotationOrder( object ) {
			switch ( object.rotation.order ) {
				case 'ZYX':
					return 0;
				case 'YZX':
					return 1;
				case 'XZY':
					return 2;
				case 'ZXY':
					return 3;
				case 'YXZ':
					return 4;
				case 'XYZ':
				default:
					return 5;
			}
		}

	handleMesh( mesh: Mesh, modelId: number ) {
		const materials = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ];
		const geometryId = this.getNextId();

		// Create Geometry
		this.createGeometry( mesh.geometry, geometryId, materials.length );

		// Connect Geometry to Model
		this.addConnection( geometryId, modelId, 'OO' );

		// Handle materials (can be single or array)
		for ( const material of materials ) {
			const materialId = this.getNextId();

			// Create Material
			this.createMaterial( material, materialId );

			// Create Textures if they exist
			const textureInfos = this.createTextures( material );

			// Connect Material to Model
			this.addConnection( materialId, modelId, 'OO' );

			// Connect Textures to Material
			for ( const textureInfo of textureInfos ) {
				this.addConnection( textureInfo.id, materialId, 'OP', textureInfo.property );
			}
		}
	}

	createGeometry( geometry: BufferGeometry, id: number, materialCount = 1 ) {
		const geo: any = {
			id: id,
			attrName: geometry.name && geometry.name.length > 0 ? geometry.name : 'Geometry',
			fbxClass: 'Geometry',
			attrType: 'Mesh',
			Properties70: {}
		};

		// Vertices
		if ( geometry.attributes.position ) {
			const positions = geometry.attributes.position.array;
			geo.Vertices = { a: Array.from( positions ), dataType: 'd' };
		}

		// Polygon indices and UV handling
		const vertexCount = geometry.attributes.position.count;
		const polygonVertexIndex: number[] = [];
		const polygonVertices: number[] = [];

		if ( geometry.index ) {
			// Indexed geometry
			const indices = geometry.index.array;
			for ( let i = 0; i < indices.length; i += 3 ) {
				const i0 = indices[i];
				const i1 = indices[i + 1];
				const i2 = indices[i + 2];
				polygonVertexIndex.push( i0, i1, -( i2 + 1 ) );
				polygonVertices.push( i0, i1, i2 );
			}
		} else {
			// Non-indexed geometry
			for ( let i = 0; i < vertexCount; i += 3 ) {
				polygonVertexIndex.push( i, i + 1, -( ( i + 2 ) + 1 ) );
				polygonVertices.push( i, i + 1, i + 2 );
			}
		}

		geo.PolygonVertexIndex = { a: polygonVertexIndex, dataType: 'i' };
		const polygonCount = polygonVertexIndex.length / 3;

		// Normals
		if ( geometry.attributes.normal ) {
			const normals = geometry.attributes.normal.array;
			const normalArray = Array.from( normals );
			const normalIndices = geometry.index
				? Array.from( geometry.index.array )
				: Array.from( { length: vertexCount }, ( _, index ) => index );

			geo.LayerElementNormal = {
				0: {
					Version: 102,
					Name: '',
					MappingInformationType: 'ByPolygonVertex',
					ReferenceInformationType: 'IndexToDirect',
						Normals: { a: normalArray, dataType: 'd' },
						NormalsIndex: { a: normalIndices, dataType: 'i' }
				}
			};
		}

		// Tangents
		if ( geometry.attributes.tangent ) {
			const tangents = geometry.attributes.tangent.array;
			const tangentArray: number[] = [];
			if ( geometry.index ) {
				// For indexed geometry, tangents need to be in the same order as polygon vertices
				const indices = geometry.index.array;
				for ( let i = 0; i < indices.length; i++ ) {
					const idx = indices[i] * 4;
					tangentArray.push( tangents[idx], tangents[idx + 1], tangents[idx + 2] );
				}
			} else {
				// For non-indexed geometry, copy tangents but only the first 3 components (x,y,z)
				for ( let i = 0; i < tangents.length; i += 4 ) {
					tangentArray.push( tangents[i], tangents[i + 1], tangents[i + 2] );
				}
			}
			geo.LayerElementTangent = {
				0: {
					Version: 101,
					Name: 'Tangents',
					MappingInformationType: 'ByPolygonVertex',
					ReferenceInformationType: 'Direct',
						Tangents: { a: tangentArray, dataType: 'd' }
				}
			};
		}

		// UV layers
		const uvAttributeNames = this.getUvAttributeNames( geometry );
		if ( uvAttributeNames.length > 0 ) {
			geo.LayerElementUV = {};

			for ( let layerIndex = 0; layerIndex < uvAttributeNames.length; layerIndex ++ ) {
				const attributeName = uvAttributeNames[ layerIndex ];
				const uvAttribute = geometry.getAttribute( attributeName );
				if ( ! uvAttribute || uvAttribute.itemSize < 2 ) continue;

				const uvArray: number[] = [];
				for ( const vertexIndex of polygonVertices ) {
					const uvOffset = vertexIndex * uvAttribute.itemSize;
					uvArray.push( uvAttribute.array[ uvOffset ], 1 - uvAttribute.array[ uvOffset + 1 ] );
				}

				geo.LayerElementUV[ layerIndex ] = {
					Version: 101,
					Name: layerIndex === 0 ? 'UVMap' : attributeName,
					MappingInformationType: 'ByPolygonVertex',
					ReferenceInformationType: 'Direct',
					UV: { a: uvArray, dataType: 'd' }
				};
			}
		}

		// Vertex Colors
		if ( geometry.attributes.color ) {
			const colors = geometry.attributes.color.array;
			const colorArray: number[] = [];
			const itemSize = geometry.attributes.color.itemSize;
			if ( geometry.index ) {
				// For indexed geometry, colors need to be in the same order as polygon vertices
				const indices = geometry.index.array;
				for ( let i = 0; i < indices.length; i++ ) {
					const idx = indices[i] * itemSize;
					for ( let j = 0; j < itemSize; j++ ) {
						colorArray.push( colors[idx + j] );
					}
					// Pad to 4 components if needed
					while ( colorArray.length % 4 !== 0 ) {
						colorArray.push( 1.0 );
					}
				}
			} else {
				for ( let i = 0; i < colors.length; i += itemSize ) {
					for ( let j = 0; j < itemSize; j++ ) {
						colorArray.push( colors[i + j] );
					}
					// Pad to 4 components if needed
					while ( colorArray.length % 4 !== 0 ) {
						colorArray.push( 1.0 );
					}
				}
			}
			geo.LayerElementColor = {
				0: {
					Version: 101,
					Name: 'Colors',
					MappingInformationType: 'ByPolygonVertex',
					ReferenceInformationType: 'Direct',
						Colors: { a: colorArray, dataType: 'd' }
				}
			};
		}

		if ( polygonCount > 0 && ( materialCount > 1 || geometry.groups.length > 0 ) ) {
			const materialIndices = new Array<number>( polygonCount ).fill( 0 );

			for ( const group of geometry.groups ) {
				const materialIndex = Math.max( 0, Math.min( materialCount - 1, group.materialIndex ?? 0 ) );
				const polygonStart = Math.max( 0, Math.floor( group.start / 3 ) );
				const groupPolygonCount = Math.max( 0, Math.floor( group.count / 3 ) );

				for ( let i = 0; i < groupPolygonCount; i ++ ) {
					const polygonIndex = polygonStart + i;
					if ( polygonIndex >= materialIndices.length ) break;
					materialIndices[ polygonIndex ] = materialIndex;
				}
			}

			geo.LayerElementMaterial = {
				0: {
					Version: 101,
					Name: '',
					MappingInformationType: 'ByPolygon',
					ReferenceInformationType: 'IndexToDirect',
						Materials: { a: materialIndices, dataType: 'i' }
				}
			};
		}

		this.objects.Geometry[ id ] = geo;
	}

	createMaterial( material: Material, id: number ) {
		let shadingModel = 'phong';
		let attrType = 'Phong';

		if ( material.type === 'MeshLambertMaterial' || material.type === 'MeshBasicMaterial' ) {
			shadingModel = 'lambert';
			attrType = 'Lambert';
		} else if ( material.type === 'MeshPhongMaterial' ) {
			shadingModel = 'phong';
			attrType = 'Phong';
		}
		const isLambertShading = shadingModel === 'lambert';

		const mat: any = {
			id: id,
			attrName: material.name && material.name.length > 0 ? material.name : 'Material',
			fbxClass: 'Material',
			attrType: attrType,
			Version: 102,
			ShadingModel: shadingModel,
			Properties70: {
				P: []
			}
		};

		const isStandardMaterial = material.type === 'MeshStandardMaterial';

		// Diffuse color
		if ( (material as any).color ) {
			const color = (material as any).color;
			mat.Properties70.P.push({
				name: 'DiffuseColor',
				type: 'ColorRGB',
				label: 'Color',
				value: [ color.r, color.g, color.b ]
			});
		}

		// Ambient color (for AO)
		if ( (material as any).aoMap ) {
			mat.Properties70.P.push({
				name: 'AmbientColor',
				type: 'ColorRGB',
				label: 'Color',
				value: [ 1, 1, 1 ]
			});
		}

		// Specular color (for metallic)
		if ( (material as any).metalness !== undefined ) {
			const metalness = (material as any).metalness;
			mat.Properties70.P.push({
				name: 'SpecularColor',
				type: 'ColorRGB',
				label: 'Color',
				value: [ metalness, metalness, metalness ]
			});
			mat.Properties70.P.push({
				name: 'ReflectionFactor',
				type: 'double',
				label: 'Number',
				value: metalness
			});
		}

		// Emissive color
		if ( isStandardMaterial && (material as any).emissive ) {
			const emissive = (material as any).emissive;
			mat.Properties70.P.push({
				name: 'EmissiveColor',
				type: 'ColorRGB',
				label: 'Color',
				value: [ emissive.r, emissive.g, emissive.b ]
			});
		}

			if ( (material as any).opacity !== undefined && ( (material as any).transparent || (material as any).opacity < 1 ) ) {
				mat.Properties70.P.push({
					name: 'Opacity',
					type: 'double',
					label: 'Number',
					value: (material as any).opacity
				});
			}

			if ( (material as any).side === DoubleSide ) {
				mat.Properties70.P.push({
					name: 'DoubleSided',
					type: 'bool',
					value: 1
				});
			}

		// Shininess (for roughness)
		if ( ! isLambertShading ) {
			let shininess = 30; // default
			if ( (material as any).roughness !== undefined ) {
				const roughness = (material as any).roughness;
				// Inverse of: roughness = 1.0 - (Math.sqrt(shininess) / 10.0)
				shininess = Math.pow(10 * (1 - roughness), 2);
			} else if ( (material as any).shininess !== undefined ) {
				shininess = (material as any).shininess;
			}
			mat.Properties70.P.push({
				name: 'Shininess',
				type: 'double',
				label: 'Number',
				value: shininess
			});
		}

		this.objects.Material[ id ] = mat;
	}

	createTextures( material: Material ): { id: number; property: string }[] {
		const textureInfos: { id: number; property: string }[] = [];
		const materialName = material.name || 'Material';

		// Create combined textures if needed
		const combinedTextures = this.createCombinedTexture(material, materialName);

		// Handle BR texture (Base Color + Roughness)
		if (combinedTextures.br) {
			const textureId = this.getNextId();
			const videoId = this.getNextId();
			this.createTexture(combinedTextures.br, textureId, videoId, 'DiffuseColor', materialName, 'BR');
			textureInfos.push({ id: textureId, property: 'DiffuseColor' });
		} else {
			// Fallback to individual diffuse texture
			if ((material as any).map) {
				const textureId = this.getNextId();
				const videoId = this.getNextId();
				this.createTexture((material as any).map, textureId, videoId, 'DiffuseColor', materialName, 'Diffuse');
				textureInfos.push({ id: textureId, property: 'DiffuseColor' });
			}
			// Also create individual roughness texture if it exists
			if ((material as any).roughnessMap) {
				const textureId = this.getNextId();
				const videoId = this.getNextId();
				this.createTexture((material as any).roughnessMap, textureId, videoId, 'SpecularFactor', materialName, 'Roughness');
				textureInfos.push({ id: textureId, property: 'SpecularFactor' });
			}
		}

		// Handle MEO texture (Metalness + Emissive + AO)
		if (combinedTextures.meo) {
			const textureId = this.getNextId();
			const videoId = this.getNextId();
			this.createTexture(combinedTextures.meo, textureId, videoId, 'SpecularColor', materialName, 'MEO');
			textureInfos.push({ id: textureId, property: 'SpecularColor' });
		} else {
			// Fallback to individual textures
			if ((material as any).metalnessMap) {
				const textureId = this.getNextId();
				const videoId = this.getNextId();
				this.createTexture((material as any).metalnessMap, textureId, videoId, 'SpecularColor', materialName, 'Metallic');
				textureInfos.push({ id: textureId, property: 'SpecularColor' });
			}
			if ((material as any).emissiveMap) {
				const textureId = this.getNextId();
				const videoId = this.getNextId();
				this.createTexture((material as any).emissiveMap, textureId, videoId, 'EmissiveColor', materialName, 'Emissive');
				textureInfos.push({ id: textureId, property: 'EmissiveColor' });
			}
			if ((material as any).aoMap) {
				const textureId = this.getNextId();
				const videoId = this.getNextId();
				this.createTexture((material as any).aoMap, textureId, videoId, 'AmbientColor', materialName, 'AO');
				textureInfos.push({ id: textureId, property: 'AmbientColor' });
			}
		}

		// Handle normal map (always separate)
		if ((material as any).normalMap) {
			const textureId = this.getNextId();
			const videoId = this.getNextId();
			this.createTexture((material as any).normalMap, textureId, videoId, 'NormalMap', materialName, 'Normal');
			textureInfos.push({ id: textureId, property: 'NormalMap' });
		}

		if ((material as any).alphaMap) {
			const textureId = this.getNextId();
			const videoId = this.getNextId();
			this.createTexture((material as any).alphaMap, textureId, videoId, 'TransparencyFactor', materialName, 'Alpha');
			textureInfos.push({ id: textureId, property: 'TransparencyFactor' });
		}

		return textureInfos;
	}

	createTexture( texture: Texture, textureId: number, videoId: number, textureType: string, materialName: string, slotName: string ) {
		// Ensure filename has .png extension but avoid double extensions
		let fileName: string;
		let baseName: string;
		if (texture.name) {
			baseName = texture.name.replace(/\.png$/i, ''); // Remove existing .png extension if present
			fileName = `${baseName}.png`;
		} else {
			baseName = `${materialName}_${slotName}`;
			fileName = `${baseName}.png`;
		}
		
		// Extract texture data for embedding
		const textureData = this.extractTextureData(texture);
		const textureTransform = this.getFbxTextureTransform( texture );
		
		const tex: any = {
			id: textureId,
			attrName: baseName,
			fbxClass: 'Texture',
			attrType: '',
			FileName: fileName,
			RelativeFilename: fileName,
			Properties70: {
				P: [
					{
						name: 'Type',
						type: 'KString',
						value: 'TextureVideoClip'
					},
					{
						name: 'RelativeFilename',
						type: 'KString',
						value: fileName
					}
				]
			}
		};

			tex.Properties70.P.push({
				name: 'TextureTypeUse',
				type: 'KString',
				value: textureType
			});
			tex.Properties70.P.push({
				name: 'WrapModeU',
				type: 'enum',
				value: this.getTextureWrapMode( texture.wrapS, 'U', baseName )
			});
			tex.Properties70.P.push({
				name: 'WrapModeV',
				type: 'enum',
				value: this.getTextureWrapMode( texture.wrapT, 'V', baseName )
			});
			tex.Properties70.P.push({
				name: 'Translation',
				type: 'Vector3D',
				label: 'Vector',
				value: [ texture.offset.x, texture.offset.y, 0 ]
			});
			tex.Properties70.P.push({
				name: 'Scaling',
				type: 'Vector3D',
				label: 'Vector',
				value: [ texture.repeat.x, texture.repeat.y, 1 ]
			});

			// Store the processed texture data for later download (legacy support)
			const clonedTexture = this.prepareTextureForExport( texture );
		clonedTexture.name = fileName.replace('.png', '');
		
		// Check if a texture with this name already exists
		const existingTexture = this.textures.find(t => t.name === clonedTexture.name);
		if (!existingTexture) {
			this.textures.push( clonedTexture );
		}

		// UV set
		tex.Properties70.P.push({
			name: 'UVSet',
			type: 'KString',
			value: this.getTextureUvSet( texture )
		});

		tex.Properties70.P.push({
			name: 'Translation',
			type: 'Vector3D',
			label: 'Vector',
			value: textureTransform.translation
		});
		tex.Properties70.P.push({
			name: 'Rotation',
			type: 'Vector3D',
			label: 'Vector',
			value: textureTransform.rotation
		});
		tex.Properties70.P.push({
			name: 'Scaling',
			type: 'Vector3D',
			label: 'Vector',
			value: textureTransform.scaling
		});
		tex.Properties70.P.push({
			name: 'RotationPivot',
			type: 'Vector3D',
			label: 'Vector',
			value: textureTransform.pivot
		});
		tex.Properties70.P.push({
			name: 'ScalingPivot',
			type: 'Vector3D',
			label: 'Vector',
			value: textureTransform.pivot
		});

		// Texture type
		tex.Properties70.P.push({
			name: 'UseMaterial',
			type: 'bool',
			value: 1
		});

		this.objects.Texture[ textureId ] = tex;

		const videoAttrName = `${baseName}_Video`;
		const video: any = {
			id: videoId,
			attrName: videoAttrName,
			fbxClass: 'Video',
			attrType: 'Clip',
			Type: 'Clip',
			FileName: fileName,
			RelativeFilename: fileName,
			Properties70: {
				P: [
					{
						name: 'Path',
						type: 'KString',
						value: fileName
					}
				]
			}
		};

		// Add embedded texture data if available
		if (textureData) {
			video.Content = textureData;
		}

		this.objects.Video[ videoId ] = video;

		// Connect texture to its video source
		this.addConnection( videoId, textureId, 'OO' );
	}

	getTextureUvSet( texture: Texture ): string {
		const channel = Number.isInteger( ( texture as any ).channel ) ? ( texture as any ).channel : 0;
		return channel <= 0 ? 'UVMap' : `uv${channel}`;
	}

	getTextureWrapMode( wrapMode: number, axis: 'U' | 'V', textureName: string ): number {
		if ( wrapMode === ClampToEdgeWrapping ) {
			return 1;
		}

		if ( wrapMode === MirroredRepeatWrapping ) {
			this.warnOnce(
				'mirrored-repeat-wrapping',
				`FBX export does not support MirroredRepeatWrapping; exporting texture "${textureName}" axis ${axis} as RepeatWrapping.`
			);
		}

		return 0;
	}

	warnOnce( key: string, message: string ): void {
		if ( this.warningKeys.has( key ) ) return;
		this.warningKeys.add( key );
		console.warn( message );
	}

	collectTextures() {
		return this.textures.slice();
	}

	async createFiles( fbxFileName: string, fbxData: string | ArrayBuffer, textures: Texture[] ): Promise<Record<string, Uint8Array>> {
		const files: { [key: string]: Uint8Array } = {};

		if (fbxData instanceof ArrayBuffer) {
			files[fbxFileName] = new Uint8Array(fbxData as ArrayBuffer);
		} else if (typeof fbxData === 'string') {
			files[fbxFileName] = strToU8(fbxData);
		}
		else {
			throw new Error('FBX data must be a string or ArrayBuffer');
		}

		// Add texture files
		const texturePromises = textures.map(async (texture) => {
			const pngData = await this.convertTextureToPNG(texture);
			if (pngData) {
				files[texture.name + '.png'] = pngData;
			}
		});

		await Promise.all(texturePromises);
		return files;
	}

	convertTextureToPNG(texture: Texture): Promise<Uint8Array | null> {
		// Check if we're in an environment that doesn't support canvas (like jsdom in tests)
		if (typeof document === 'undefined' || typeof document.createElement !== 'function' ||
			typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.includes('jsdom')) {
			const textureData = this.getImmediateTextureData( texture );
			if ( textureData ) return Promise.resolve( textureData );
			return Promise.resolve(null);
		}

		// Prefer rasterizing image-backed textures through canvas so browser-hosted textures
		// are exported as standalone PNG assets without mutating their orientation on disk.
		if (texture.image) {
			try {
				const canvas = document.createElement('canvas');
				// Check if canvas actually supports getContext (not just in jsdom)
				if (typeof canvas.getContext !== 'function') {
					// Canvas not supported (e.g., in test environments like jsdom)
					return Promise.resolve(null);
				}
				let ctx: CanvasRenderingContext2D | null = null;
				try {
					ctx = canvas.getContext('2d');
				} catch (e) {
					// Canvas not supported (e.g., in test environments like jsdom)
					return Promise.resolve(null);
				}
				if (ctx && texture.image.width && texture.image.height) {
						return new Promise<Uint8Array | null>((resolve) => {
							try {
								canvas.width = texture.image.width;
								canvas.height = texture.image.height;
								ctx.drawImage(texture.image, 0, 0);
								const dataUrl = canvas.toDataURL('image/png');
								const commaIndex = dataUrl.indexOf(',');
								if (commaIndex > 0) {
									resolve( decodeBase64Bytes( dataUrl.slice( commaIndex + 1 ) ) );
									return;
								}
								resolve(null);
							} catch (e) {
								// drawImage or toBlob failed
								resolve(null);
							}
					});
				} else {
					return Promise.resolve(null);
				}
			} catch (error) {
				console.warn('Failed to convert texture to PNG:', error);
				return Promise.resolve(null);
			}
		}

		const textureData = this.getImmediateTextureData( texture );
		if ( textureData ) return Promise.resolve( textureData );

		// In environments without canvas (like Node.js/test environments), skip PNG conversion
		return Promise.resolve(null);
	}

	prepareTextureForExport( texture: Texture ) {
		// For DataTextures, return as-is since they don't need cloning for export
		if (texture instanceof DataTexture) {
			return texture;
		}
		// For regular textures, don't clone to avoid performance issues
		// Just return the texture as-is for export purposes
		return texture;
	}

	createCombinedTexture( material: Material, materialName: string ): { br?: Texture; meo?: Texture } {
		void material;
		void materialName;
		// Temporarily disable combined texture creation to avoid performance issues
		return {};
	}

	createBRTexture( material: Material, materialName: string ): Texture {
		const baseColorTexture = (material as any).map;
		const roughnessTexture = (material as any).roughnessMap;
		
		// Determine texture size - use the largest available texture
		const { width, height } = this.getMaxTextureSize([baseColorTexture, roughnessTexture]);
		
		// Create RGBA data array
		const data = new Uint8Array(width * height * 4);
		
		// Fill with base color (RGB) and roughness (A)
		for (let i = 0; i < width * height; i++) {
			const pixelIndex = i * 4;
			
			// Base color (RGB)
			let r = 255, g = 255, b = 255; // Default white
			if (baseColorTexture) {
				const baseColorData = this.getTextureData(baseColorTexture, width, height);
				r = baseColorData[pixelIndex] || 255;
				g = baseColorData[pixelIndex + 1] || 255;
				b = baseColorData[pixelIndex + 2] || 255;
			}
			
			// Roughness (A)
			let a = 128; // Default 0.5 roughness
			if (roughnessTexture) {
				const roughnessData = this.getTextureData(roughnessTexture, width, height);
				a = roughnessData[pixelIndex] || 128; // Use R channel for roughness
			}
			
			data[pixelIndex] = r;
			data[pixelIndex + 1] = g;
			data[pixelIndex + 2] = b;
			data[pixelIndex + 3] = a;
		}
		
		const texture = new DataTexture(data, width, height, RGBAFormat);
		texture.name = `${materialName}_BR`;
		return texture;
	}

	createMEOTexture( material: Material, materialName: string ): Texture {
		const metalnessTexture = (material as any).metalnessMap;
		const emissiveTexture = (material as any).emissiveMap;
		const aoTexture = (material as any).aoMap;
		
		// Determine texture size - use the largest available texture
		const { width, height } = this.getMaxTextureSize([metalnessTexture, emissiveTexture, aoTexture]);
		
		// Create RGBA data array
		const data = new Uint8Array(width * height * 4);
		
		// Fill with metalness (R), emissive (G), AO (B), and default A
		for (let i = 0; i < width * height; i++) {
			const pixelIndex = i * 4;
			
			// Metalness (R)
			let r = 0; // Default 0 metalness
			if (metalnessTexture) {
				const metalnessData = this.getTextureData(metalnessTexture, width, height);
				r = metalnessData[pixelIndex] || 0;
			}
			
			// Emissive (G) - use luminance or R channel
			let g = 0; // Default 0 emissive
			if (emissiveTexture) {
				const emissiveData = this.getTextureData(emissiveTexture, width, height);
				// Use luminance approximation: 0.299*R + 0.587*G + 0.114*B
				const emissiveR = emissiveData[pixelIndex] || 0;
				const emissiveG = emissiveData[pixelIndex + 1] || 0;
				const emissiveB = emissiveData[pixelIndex + 2] || 0;
				g = Math.round(0.299 * emissiveR + 0.587 * emissiveG + 0.114 * emissiveB);
			}
			
			// AO (B)
			let b = 255; // Default 1.0 AO (no occlusion)
			if (aoTexture) {
				const aoData = this.getTextureData(aoTexture, width, height);
				b = aoData[pixelIndex] || 255;
			}
			
			data[pixelIndex] = r;
			data[pixelIndex + 1] = g;
			data[pixelIndex + 2] = b;
			data[pixelIndex + 3] = 255; // Alpha
		}
		
		const texture = new DataTexture(data, width, height, RGBAFormat);
		texture.name = `${materialName}_MEO`;
		return texture;
	}

	getTextureData( texture: Texture, targetWidth: number, targetHeight: number ): Uint8Array {
		// For DataTextures, return the data directly
		if (texture instanceof DataTexture) {
			return texture.image.data as Uint8Array;
		}
		
		// For regular textures with image data, we'd need to read the canvas
		// For now, assume DataTextures as requested
		// Return default values
		return new Uint8Array(targetWidth * targetHeight * 4).fill(128);
	}

	getFbxTextureTransform( texture: Texture ) {
		// FBX importers expect unmodified texture pixels on disk, so we export mesh UVs
		// with a flipped V axis and conjugate the texture transform into that space.
		return {
			translation: [ texture.offset.x, -texture.offset.y, 0 ],
			rotation: [ 0, 0, MathUtils.radToDeg( texture.rotation ) ],
			scaling: [ texture.repeat.x, texture.repeat.y, 1 ],
			pivot: [ texture.center.x, 1 - texture.center.y, 0 ]
		};
	}

	getImmediateTextureData( texture: Texture ): Uint8Array | null {
		if ( texture instanceof DataTexture ) {
			const data = texture.image.data;
			if ( data instanceof Uint8Array && texture.image.width && texture.image.height ) {
				return encodePngRgba( data, texture.image.width, texture.image.height );
			}
		}

		if ( texture.image && typeof ( texture.image as any ).src === 'string' ) {
			const dataUrl = ( texture.image as any ).src;
			if ( dataUrl.startsWith( 'data:image/png;base64,' ) ) {
				return decodeBase64Bytes( dataUrl.slice( 'data:image/png;base64,'.length ) );
			}
		}

		if ( texture.source && texture.source.data ) {
			const sourceData = texture.source.data as any;
			if ( sourceData instanceof Uint8Array ) {
				return new Uint8Array( sourceData );
			}
			if ( sourceData instanceof ArrayBuffer ) {
				return new Uint8Array( sourceData );
			}
		}

		return null;
	}

	extractTextureData( texture: Texture ): Uint8Array | null {
		if ( !this.embedTextures ) return null;
		return this.getImmediateTextureData( texture );
	}

	getMaxTextureSize( textures: (Texture | undefined | null)[] ): { width: number; height: number } {
		let width = 64, height = 64; // Default minimum size
		for (const texture of textures) {
			if (texture?.image) {
				width = Math.max(width, texture.image.width);
				height = Math.max(height, texture.image.height);
			}
		}
		// Limit maximum texture size to prevent performance issues
		const maxSize = 1024; // Maximum 1024x1024 for combined textures
		if (width > maxSize || height > maxSize) {
			width = Math.min(width, maxSize);
			height = Math.min(height, maxSize);
		}
		return { width, height };
	}

	addConnection( childId: number, parentId: number, type: string, property: string | null = null ) {
		this.connections.push( { childId, parentId, type, property } );
	}

	getNextId() {
		return this.idCounter++;
	}

	generateFBX( _target, binary = false ) {
		const fbxTree = this.buildFBXTree( _target );

		if ( binary ) {
			return this.generateBinaryFBX( fbxTree );
		} else {
			return this.generateASCIIFBX( fbxTree );
		}
	}

	getEncodingType( fbxType: string ): string {
		if ( !fbxType ) return 'I';

		switch ( fbxType ) {
			case 'int':
			case 'enum':
			case 'Integer':
			case 'KInt':
				return 'I'; // 32-bit integer
			case 'double':
			case 'Number':
			case 'KDouble':
				return 'D'; // 64-bit float
			case 'KTime':
				return 'L'; // 64-bit integer
			case 'ColorRGB':
			case 'Vector':
			case 'Vector3D':
			case 'Vector3':
			case 'Float3':
				return 'D';
			case 'Lcl_Translation':
			case 'Lcl_Rotation':
			case 'Lcl_Scaling':
				return 'D'; // Vector properties should be doubles
			default:
				return 'I'; // default to 32-bit integer
		}
	}

	ensurePropertyList( prop ) {
		if ( prop === undefined || prop === null ) {
			return { propertyList: [] };
		}

		if ( Array.isArray( prop ) ) {
			return { propertyList: [ ...prop ] };
		}

		if ( Array.isArray( prop.propertyList ) ) {
			return { ...prop, propertyList: [ ...prop.propertyList ] };
		}

		const name = prop?.name ?? '';
		const type = prop?.type ?? '';
		const label = prop?.label ?? '';
		const flag = prop?.flag ?? '';

		const propertyList: any[] = [ name, type, label, flag ];
		const baseEncodingType = this.getEncodingType( type );

		const appendValue = ( value: any ) => {
			if ( value === undefined || value === null ) {
				return;
			}

			if ( Array.isArray( value ) ) {
				for ( const element of value ) {
					appendValue( element );
				}
				return;
			}

			if ( typeof value === 'number' ) {
				let encodingType = baseEncodingType;
				if ( encodingType === 'I' && ! Number.isInteger( value ) ) {
					encodingType = 'D';
				}
				propertyList.push( { value, encodingType } );
				return;
			}

			if ( value && typeof value === 'object' && value.value !== undefined && value.encodingType ) {
				propertyList.push( { value: value.value, encodingType: value.encodingType } );
				return;
			}

			propertyList.push( value );
		};

		appendValue( prop?.value );

		return {
			propertyList
		};
	}

	buildFBXTree( _target ) {
		const fbxTree: any = {};

		// FBXHeaderExtension (structural only)
		fbxTree.FBXHeaderExtension = {
			FBXHeaderVersion: 1004,
			FBXVersion: this.version,
			EncryptionType: 0,
			CreationTimeStamp: {
				Version: 1000,
				Year: 1970,
				Month: 1,
				Day: 1,
				Hour: 10,
				Minute: 0,
				Second: 0,
				Millisecond: 0
			}
		};

		// Top-level metadata expected by many readers
		fbxTree.Creator = 'FBXExporter';
		fbxTree.CreationTime = FBX_CREATION_TIME;
		fbxTree.FileId = { rawBytes: FBX_FILE_ID };

		// GlobalSettings
		fbxTree.GlobalSettings = {
			Version: 1000,
			Properties70: {
				P: this.globalSettings.map( setting => this.ensurePropertyList( {
					name: setting.name,
					type: setting.type,
					label: setting.type2 ?? '',
					flag: '',
					value: setting.value
				} ) )
			}
		};

		// Documents
		fbxTree.Documents = {
			a: 1, // Documents count as array property
			Count: 1,
			Document: {
				id: 1234567890,
				attrName: 'Scene',
				fbxClass: 'Document',
				attrType: 'Scene',
				Properties70: {
					P: [
						this.ensurePropertyList( { name: 'SourceObject', type: 'object', label: '', value: '' } ),
						this.ensurePropertyList( { name: 'ActiveAnimStackName', type: 'KString', label: '', value: 'AnimStack::Take 001' } )
					]
				},
				RootNode: 0
			}
		};

		// References
		fbxTree.References = {
			Version: 100
		};

		// Definitions
		fbxTree.Definitions = {
			a: 4, // Definitions count as array property
			Version: 100,
			Count: this.getDefinitionCount(),
			ObjectType: []
		};

		// Add definitions for each object type
		for ( const [ type, objects ] of Object.entries( this.objects as any ) ) {
			const count = Object.keys( objects as any ).length;
			if ( count > 0 ) {
				fbxTree.Definitions.ObjectType.push( {
					name: type,
					attrName: type,
					Count: count,
					a: count
				} );
			}
		}

		// Objects
		fbxTree.Objects = {};
		for ( const [ type, objects ] of Object.entries( this.objects as any ) ) {
			for ( const [ id, obj ] of Object.entries( objects as any ) ) {
				if ( ! fbxTree.Objects[ type ] ) fbxTree.Objects[ type ] = {};
				fbxTree.Objects[ type ][ id ] = this.buildObjectNode( type, obj );
			}
		}

		// Connections
		fbxTree.Connections = {
			connections: this.connections.map( conn => {
				if ( conn.property ) {
					return [ conn.childId, conn.parentId, conn.type, conn.property ];
				} else {
					return [ conn.childId, conn.parentId, conn.type ];
				}
			} ),
			C: this.connections.map( conn => {
				const propertyList: any[] = [
					conn.type,
					{ value: conn.childId, encodingType: 'L' },
					{ value: conn.parentId, encodingType: 'L' }
				];
				if ( conn.property ) {
					propertyList.push( conn.property );
				}
				return { propertyList };
			} )
		};

		// Takes (for animations, placeholder)
		fbxTree.Takes = {
			Current: 'Take 001',
			Take: {
				attrName: 'Take 001',
				FileName: 'Take 001.tak',
				LocalTime: [ 0, 0 ],
				ReferenceTime: [ 0, 0 ]
			}
		};

		return fbxTree;
	}

	buildObjectNode( type, obj ) {
		const node: any = {
			id: obj.id,
			attrName: obj.attrName,
			attrType: obj.attrType
		};

		if ( obj.fbxClass ) {
			node.fbxClass = obj.fbxClass;
		}

		if ( obj.Version !== undefined ) {
			node.Version = obj.Version;
		}

		if ( obj.ShadingModel ) {
			node.ShadingModel = typeof obj.ShadingModel === 'object' && obj.ShadingModel.value !== undefined
				? obj.ShadingModel.value
				: obj.ShadingModel;
		}

			if ( obj.Type !== undefined ) {
				node.Type = obj.Type;
			}

			if ( obj.Culling !== undefined ) {
				node.Culling = obj.Culling;
			}

		if ( obj.UseMipMap !== undefined ) {
			node.UseMipMap = obj.UseMipMap;
		}

		// Direct properties (not in Properties70)
		if ( obj.FileName !== undefined ) {
			node.FileName = obj.FileName;
		}
		if ( obj.RelativeFilename !== undefined ) {
			node.RelativeFilename = obj.RelativeFilename;
		}
		if ( obj.WrapModeU !== undefined ) {
			node.WrapModeU = obj.WrapModeU;
		}
		if ( obj.WrapModeV !== undefined ) {
			node.WrapModeV = obj.WrapModeV;
		}
		if ( obj.Translation !== undefined ) {
			node.Translation = obj.Translation;
		}
		if ( obj.Scaling !== undefined ) {
			node.Scaling = obj.Scaling;
		}

		// Content field for embedded textures (Video objects)
		if ( obj.Content !== undefined ) {
			node.Content = obj.Content;
		}

		// Properties70
		if ( obj.Properties70 && obj.Properties70.P ) {
			node.Properties70 = {
				P: obj.Properties70.P.map( prop => this.ensurePropertyList( prop ) )
			};
		}

		// Geometry specific
		if ( type === 'Geometry' ) {
			const layerEntries: any[] = [];

				if ( obj.Vertices ) {
					node.Vertices = { a: obj.Vertices.a, dataType: obj.Vertices.dataType ?? 'd' };
				}
				if ( obj.PolygonVertexIndex ) {
					node.PolygonVertexIndex = { a: obj.PolygonVertexIndex.a, dataType: obj.PolygonVertexIndex.dataType ?? 'i' };
				}
			if ( obj.LayerElementNormal ) {
				const layer = obj.LayerElementNormal[ 0 ];
				const normalLayer: any = {
					id: 0,
					Version: layer.Version ?? 102,
					Name: layer.Name ?? '',
					MappingInformationType: layer.MappingInformationType ?? 'ByPolygonVertex',
					ReferenceInformationType: layer.ReferenceInformationType ?? 'Direct'
				};
					if ( layer.Normals ) {
						normalLayer.Normals = { a: layer.Normals.a, dataType: layer.Normals.dataType ?? 'd' };
					}
					if ( layer.NormalsW ) {
						normalLayer.NormalsW = { a: layer.NormalsW.a, dataType: layer.NormalsW.dataType ?? 'd' };
					}
					if ( layer.NormalsIndex ) {
						normalLayer.NormalsIndex = { a: layer.NormalsIndex.a, dataType: layer.NormalsIndex.dataType ?? 'i' };
					}
				node.LayerElementNormal = [ normalLayer ];
				layerEntries.push( {
					Type: 'LayerElementNormal',
					TypedIndex: 0
				} );
			}
			if ( obj.LayerElementTangent ) {
				const layer = obj.LayerElementTangent[ 0 ];
				node.LayerElementTangent = [ {
					id: 0,
					Version: layer.Version ?? 101,
					Name: layer.Name ?? 'Tangents',
					MappingInformationType: layer.MappingInformationType ?? 'ByPolygonVertex',
					ReferenceInformationType: layer.ReferenceInformationType ?? 'Direct',
						Tangents: { a: layer.Tangents.a, dataType: layer.Tangents.dataType ?? 'd' }
				} ];
				layerEntries.push( {
					Type: 'LayerElementTangent',
					TypedIndex: 0
				} );
			}
			if ( obj.LayerElementColor ) {
				const layer = obj.LayerElementColor[ 0 ];
				node.LayerElementColor = [ {
					id: 0,
					Version: layer.Version ?? 101,
					Name: layer.Name ?? 'Colors',
					MappingInformationType: layer.MappingInformationType ?? 'ByPolygonVertex',
					ReferenceInformationType: layer.ReferenceInformationType ?? 'Direct',
						Colors: { a: layer.Colors.a, dataType: layer.Colors.dataType ?? 'd' }
				} ];
				layerEntries.push( {
					Type: 'LayerElementColor',
					TypedIndex: 0
				} );
			}
			if ( obj.LayerElementUV ) {
				node.LayerElementUV = [];

				for ( const [ key, rawLayer ] of Object.entries( obj.LayerElementUV ) ) {
					const layer: any = rawLayer;
					const typedIndex = Number( key );
					const uvLayer: any = {
						id: typedIndex,
						Version: layer.Version ?? 101,
						Name: layer.Name ?? ( typedIndex === 0 ? 'UVMap' : `uv${typedIndex}` ),
						MappingInformationType: layer.MappingInformationType ?? 'ByPolygonVertex',
						ReferenceInformationType: layer.ReferenceInformationType ?? 'Direct'
					};
						if ( layer.UV ) {
							uvLayer.UV = { a: layer.UV.a, dataType: layer.UV.dataType ?? 'd' };
						}
						if ( layer.UVIndex ) {
							uvLayer.UVIndex = { a: layer.UVIndex.a, dataType: layer.UVIndex.dataType ?? 'i' };
						}
					node.LayerElementUV.push( uvLayer );
					layerEntries.push( {
						Type: 'LayerElementUV',
						TypedIndex: typedIndex
					} );
				}
			}
			if ( obj.LayerElementMaterial ) {
				const layer = obj.LayerElementMaterial[ 0 ];
				node.LayerElementMaterial = [ {
					id: 0,
					Version: layer.Version ?? 101,
					Name: layer.Name ?? '',
					MappingInformationType: layer.MappingInformationType ?? 'ByPolygon',
					ReferenceInformationType: layer.ReferenceInformationType ?? 'IndexToDirect',
						Materials: { a: layer.Materials.a, dataType: layer.Materials.dataType ?? 'i' }
				} ];
				layerEntries.push( {
					Type: 'LayerElementMaterial',
					TypedIndex: 0
				} );
			}
			if ( layerEntries.length > 0 ) {
				node.Layer = [ {
					id: 0,
					Version: 100,
					LayerElement: layerEntries
				} ];
			}
		}

		return node;
	}

	generateASCIIFBX( fbxTree ) {
		let fbx = '';

		// FBX ASCII header comment
		fbx += '; FBX 7.4.0 project file\n';
		fbx += '; Copyright (C) 1997-2015 Autodesk Inc. and/or its licensors.\n';
		fbx += '; All rights reserved.\n';
		fbx += '; ----------------------------------------------------\n\n';

		// Helper for indentation (tabs per level)
		const indent = (level) => '\t'.repeat(level);

		// FBXHeaderExtension
		fbx += 'FBXHeaderExtension: {\n';
		fbx += indent(1) + 'FBXHeaderVersion: 1004\n';
		const headerVersion = fbxTree.FBXHeaderExtension.FBXVersion;
		const headerVersionValue = (headerVersion && typeof headerVersion === 'object' && headerVersion.value !== undefined)
			? headerVersion.value
			: headerVersion;
		fbx += indent(1) + 'FBXVersion: ' + headerVersionValue + '\n';
		fbx += indent(1) + 'EncryptionType: 0\n';
		fbx += indent(1) + 'CreationTimeStamp: {\n';
		fbx += indent(2) + 'Version: 1000\n';
		fbx += indent(2) + 'Year: 2023\n';
		fbx += indent(2) + 'Month: 10\n';
		fbx += indent(2) + 'Day: 3\n';
		fbx += indent(2) + 'Hour: 12\n';
		fbx += indent(2) + 'Minute: 0\n';
		fbx += indent(2) + 'Second: 0\n';
		fbx += indent(2) + 'Millisecond: 0\n';
		fbx += indent(1) + '}\n';
		fbx += indent(1) + 'Creator: "FBXExporter"\n';
		fbx += '}\n\n';

		// GlobalSettings
		fbx += 'GlobalSettings: {\n';
		fbx += indent(1) + 'Version: 1000\n';
		fbx += indent(1) + 'Properties70: {\n';
		for ( const prop of fbxTree.GlobalSettings.Properties70.P ) {
			const list = prop.propertyList ?? [];
			const [name, type, label, flag, ...values] = list;
			const normalizedValues = values
				.map( value => ( value && typeof value === 'object' && value.value !== undefined ) ? value.value : value )
				.filter( value => value !== undefined );
			const valuePayload = normalizedValues.length === 0
				? prop.value
				: ( normalizedValues.length === 1 ? normalizedValues[0] : normalizedValues );
			const valueStr = this.formatPropertyValue( valuePayload, type );
			fbx += indent(2) + `P: "${name}", "${type}", "${label}", "${flag ?? ''}", ${valueStr}\n`;
		}
		fbx += indent(1) + '}\n';
		fbx += '}\n\n';

		// Documents
		fbx += 'Documents: 1 {\n';
		fbx += indent(1) + 'Count: 1\n';
		const doc = fbxTree.Documents.Document;
		fbx += indent(1) + `Document: ${doc.id}, "${doc.attrName}", "${doc.attrType}" {\n`;
		fbx += indent(2) + 'Properties70: {\n';
		for ( const prop of doc.Properties70.P ) {
			const list = prop.propertyList ?? [];
			const [name, type, label, flag, ...values] = list;
			const normalizedValues = values
				.map( value => ( value && typeof value === 'object' && value.value !== undefined ) ? value.value : value )
				.filter( value => value !== undefined );
			const valuePayload = normalizedValues.length === 0
				? prop.value
				: ( normalizedValues.length === 1 ? normalizedValues[0] : normalizedValues );
			const valueStr = this.formatPropertyValue( valuePayload, type );
			fbx += indent(3) + `P: "${name}", "${type}", "${label}", "${flag ?? ''}", ${valueStr}\n`;
		}
		fbx += indent(2) + '}\n';
		fbx += indent(2) + 'RootNode: 0\n';
		fbx += indent(1) + '}\n';
		fbx += '}\n\n';

		// References
		fbx += 'References: {\n';
		fbx += '}\n\n';

		// Definitions
		fbx += 'Definitions: 4 {\n';
		fbx += indent(1) + 'Version: 100\n';
		fbx += indent(1) + 'Count: ' + fbxTree.Definitions.Count + '\n';

		// Add definitions for each object type
		for ( const objType of fbxTree.Definitions.ObjectType ) {
			fbx += indent(1) + `ObjectType: "${objType.name}", ${objType.Count} {\n`;
			fbx += indent(2) + `Count: ${objType.Count}\n`;
			fbx += indent(1) + '}\n';
		}

		fbx += '}\n\n';

		// Objects
		fbx += 'Objects: {\n';

		// Write all objects
		for ( const [ type, objects ] of Object.entries( fbxTree.Objects ) ) {
			for ( const obj of Object.values( objects as any ) ) {
				fbx += this.writeObjectFromNode( type, obj );
			}
		}

		fbx += '}\n\n';

		// Connections
		fbx += 'Connections: {\n';
		for ( const conn of fbxTree.Connections.connections ) {
			if ( conn.length === 4 ) {
				fbx += this.indent(1) + `C: "${conn[2]}",${conn[0]},${conn[1]},"${conn[3]}"\n`;
			} else {
				fbx += this.indent(1) + `C: "${conn[2]}",${conn[0]},${conn[1]}\n`;
			}
		}
		fbx += '}\n\n';

		// Takes (for animations, placeholder)
		fbx += 'Takes: {\n';
		fbx += indent(1) + 'Current: "Take 001"\n';
		const take = fbxTree.Takes.Take;
		fbx += indent(1) + `Take: "${take.attrName}" {\n`;
		fbx += indent(2) + `FileName: "${take.FileName}"\n`;
		fbx += indent(2) + `LocalTime: ${take.LocalTime[0]},${take.LocalTime[1]}\n`;
		fbx += indent(2) + `ReferenceTime: ${take.ReferenceTime[0]},${take.ReferenceTime[1]}\n`;
		fbx += indent(1) + '}\n';
		fbx += '}\n';

		return fbx;
	}

	writeGeometryLayers( obj: any ): string {
		let str = '';

		if ( obj.LayerElementNormal ) {
			const layer = obj.LayerElementNormal[ 0 ];
			str += this.indent(2) + 'LayerElementNormal: 0 {\n';
			str += this.indent(3) + 'Version: 102\n';
			str += this.indent(3) + 'Name: ""\n';
			str += this.indent(3) + 'MappingInformationType: "ByPolygonVertex"\n';
			str += this.indent(3) + `ReferenceInformationType: "${layer.ReferenceInformationType || 'IndexToDirect'}"\n`;
			str += this.indent(3) + `Normals: *${layer.Normals.a.length} {\n`;
			str += this.indent(4) + `a: ${layer.Normals.a.join(',')}\n`;
			str += this.indent(3) + `}\n`;
			if ( layer.NormalsIndex ) {
				str += this.indent(3) + `NormalsIndex: *${layer.NormalsIndex.a.length} {\n`;
				str += this.indent(4) + `a: ${layer.NormalsIndex.a.join(',')}\n`;
				str += this.indent(3) + `}\n`;
			}
			str += this.indent(2) + '}\n';
		}

		if ( obj.LayerElementTangent ) {
			str += this.indent(2) + 'LayerElementTangent: 0 {\n';
			str += this.indent(3) + 'Version: 101\n';
			str += this.indent(3) + 'Name: "Tangents"\n';
			str += this.indent(3) + 'MappingInformationType: "ByPolygonVertex"\n';
			str += this.indent(3) + 'ReferenceInformationType: "Direct"\n';
			str += this.indent(3) + `Tangents: *${obj.LayerElementTangent[0].Tangents.a.length} {\n`;
			str += this.indent(4) + `a: ${obj.LayerElementTangent[0].Tangents.a.join(',')}\n`;
			str += this.indent(3) + `}\n`;
			str += this.indent(2) + '}\n';
		}

		if ( obj.LayerElementColor ) {
			str += this.indent(2) + 'LayerElementColor: 0 {\n';
			str += this.indent(3) + 'Version: 101\n';
			str += this.indent(3) + 'Name: "Colors"\n';
			str += this.indent(3) + 'MappingInformationType: "ByPolygonVertex"\n';
			str += this.indent(3) + 'ReferenceInformationType: "Direct"\n';
			str += this.indent(3) + `Colors: *${obj.LayerElementColor[0].Colors.a.length} {\n`;
			str += this.indent(4) + `a: ${obj.LayerElementColor[0].Colors.a.join(',')}\n`;
			str += this.indent(3) + `}\n`;
			str += this.indent(2) + '}\n';
		}

		if ( obj.LayerElementUV ) {
			for ( const [ key, rawLayer ] of Object.entries( obj.LayerElementUV ) ) {
				const layer: any = rawLayer;
				str += this.indent(2) + `LayerElementUV: ${key} {\n`;
				str += this.indent(3) + `Version: ${layer.Version ?? 101}\n`;
				str += this.indent(3) + `Name: "${layer.Name ?? ( Number( key ) === 0 ? 'UVMap' : `uv${key}` )}"\n`;
				str += this.indent(3) + `MappingInformationType: "${layer.MappingInformationType ?? 'ByPolygonVertex'}"\n`;
				str += this.indent(3) + `ReferenceInformationType: "${layer.ReferenceInformationType ?? 'Direct'}"\n`;
				if ( layer.UV ) {
					str += this.indent(3) + `UV: *${layer.UV.a.length} {\n`;
					str += this.indent(4) + `a: ${layer.UV.a.join(',')}\n`;
					str += this.indent(3) + `}\n`;
				}
				if ( layer.UVIndex ) {
					str += this.indent(3) + `UVIndex: *${layer.UVIndex.a.length} {\n`;
					str += this.indent(4) + `a: ${layer.UVIndex.a.join(',')}\n`;
					str += this.indent(3) + `}\n`;
				}
				str += this.indent(2) + '}\n';
			}
		}

		if ( obj.LayerElementMaterial ) {
			const layer = obj.LayerElementMaterial[ 0 ];
			str += this.indent(2) + 'LayerElementMaterial: 0 {\n';
			str += this.indent(3) + `Version: ${layer.Version ?? 101}\n`;
			str += this.indent(3) + `Name: "${layer.Name ?? ''}"\n`;
			str += this.indent(3) + `MappingInformationType: "${layer.MappingInformationType ?? 'ByPolygon'}"\n`;
			str += this.indent(3) + `ReferenceInformationType: "${layer.ReferenceInformationType ?? 'IndexToDirect'}"\n`;
			if ( layer.Materials ) {
				str += this.indent(3) + `Materials: *${layer.Materials.a.length} {\n`;
				str += this.indent(4) + `a: ${layer.Materials.a.join(',')}\n`;
				str += this.indent(3) + '}\n';
			}
			str += this.indent(2) + '}\n';
		}

		if ( obj.Layer && obj.Layer.length > 0 ) {
			const layer = obj.Layer[ 0 ];
			str += this.indent(2) + 'Layer: 0 {\n';
			str += this.indent(3) + `Version: ${layer.Version ?? 100}\n`;
			for ( const layerElement of layer.LayerElement ?? [] ) {
				str += this.indent(3) + 'LayerElement:  {\n';
				str += this.indent(4) + `Type: "${layerElement.Type}"\n`;
				str += this.indent(4) + `TypedIndex: ${layerElement.TypedIndex}\n`;
				str += this.indent(3) + '}\n';
			}
			str += this.indent(2) + '}\n';
		}

		return str;
	}

	formatPropertyValue( value: any, type?: string ): string {
		if ( value === undefined || value === null ) {
			return '';
		}

		if ( Array.isArray( value ) ) {
			return value.map( entry => this.formatPropertyValue( entry, type ) ).join( ',' );
		}

		if ( value && typeof value === 'object' && value.value !== undefined ) {
			return this.formatPropertyValue( value.value, type );
		}

		if ( type === 'KString' || typeof value === 'string' ) {
			return `"${value}"`;
		}

		return String( value );
	}

	writeObjectFromNode( type, obj ) {
		const name = obj.attrName;
		const typeAttr = obj.attrType;
		let str = this.indent(1) + `${type}: ${obj.id}, "${name}", "${typeAttr}" {\n`;

		if ( obj.Version !== undefined ) {
			str += this.indent(2) + `Version: ${obj.Version}\n`;
		}

		if ( obj.ShadingModel ) {
			const shadingModelValue = obj.ShadingModel.propertyList ? obj.ShadingModel.propertyList[ 0 ] : obj.ShadingModel;
			str += this.indent(2) + `ShadingModel: "${shadingModelValue}"\n`;
		}

			if ( obj.Type !== undefined ) {
				str += this.indent(2) + `Type: "${obj.Type}"\n`;
			}

			if ( obj.Culling !== undefined ) {
				str += this.indent(2) + `Culling: "${obj.Culling}"\n`;
			}

		if ( obj.UseMipMap !== undefined ) {
			str += this.indent(2) + `UseMipMap: ${obj.UseMipMap}\n`;
		}

		// Direct properties (not in Properties70)
		if ( obj.FileName !== undefined ) {
			str += this.indent(2) + `FileName: "${obj.FileName}"\n`;
		}
		if ( obj.RelativeFilename !== undefined ) {
			str += this.indent(2) + `RelativeFilename: "${obj.RelativeFilename}"\n`;
		}
		if ( obj.WrapModeU !== undefined ) {
			str += this.indent(2) + `WrapModeU: ${obj.WrapModeU}\n`;
		}
		if ( obj.WrapModeV !== undefined ) {
			str += this.indent(2) + `WrapModeV: ${obj.WrapModeV}\n`;
		}
		if ( obj.Translation !== undefined ) {
			const values = obj.Translation.propertyList
				? obj.Translation.propertyList.map( ( entry: any ) => entry.value )
				: obj.Translation;
			str += this.indent(2) + `Translation: ${values.join(',')}\n`;
		}
		if ( obj.Scaling !== undefined ) {
			const values = obj.Scaling.propertyList
				? obj.Scaling.propertyList.map( ( entry: any ) => entry.value )
				: obj.Scaling;
			str += this.indent(2) + `Scaling: ${values.join(',')}\n`;
		}

		// Content field for embedded textures (Video objects)
			if ( obj.Content !== undefined ) {
				const contentData = obj.Content;
				if ( contentData instanceof Uint8Array ) {
					const base64Data = encodeBase64Bytes( contentData );
					str += this.indent(2) + `Content: "${base64Data}"\n`;
				}
			}

		// Properties70
		if ( obj.Properties70 && obj.Properties70.P ) {
			str += this.indent(2) + 'Properties70: {\n';
			for ( const prop of obj.Properties70.P ) {
				const list = prop.propertyList ?? (Array.isArray(prop) ? prop : []);
				const name = list[0] ?? prop.name ?? '';
				const type = list[1] ?? prop.type ?? '';
				const label = list[2] ?? prop.label ?? '';
				const flag = list[3] ?? prop.flag ?? '';
				const valueSlice = list.slice(4);
				const normalizedValues = valueSlice
					.map( value => ( value && typeof value === 'object' && value.value !== undefined ) ? value.value : value )
					.filter( value => value !== undefined );
				const rawValue = normalizedValues.length === 0
					? prop.value
					: ( normalizedValues.length === 1 ? normalizedValues[0] : normalizedValues );
				const valueStr = this.formatPropertyValue( rawValue, type );
				str += this.indent(3) + `P: "${name}", "${type}", "${label}", "${flag}", ${valueStr}\n`;
			}
			str += this.indent(2) + '}\n';
		}

		// Geometry specific
		if ( type === 'Geometry' ) {
			if ( obj.Vertices ) {
				str += this.indent(2) + `Vertices: *${obj.Vertices.a.length} {\n`;
				str += this.indent(3) + `a: ${obj.Vertices.a.join(',')}\n`;
				str += this.indent(2) + `}\n`;
			}
			if ( obj.PolygonVertexIndex ) {
				str += this.indent(2) + `PolygonVertexIndex: *${obj.PolygonVertexIndex.a.length} {\n`;
				str += this.indent(3) + `a: ${obj.PolygonVertexIndex.a.join(',')}\n`;
				str += this.indent(2) + `}\n`;
			}
			str += this.writeGeometryLayers( obj );
		}

		str += this.indent(1) + '}\n';
		return str;
	}

	generateBinaryFBX( fbxTree ) {
		// Calculate required buffer size based on embedded texture data
		let estimatedSize = 16 * 1024 * 1024; // 16MB base size
		
		// Add size for embedded textures
		const objects = fbxTree.Objects || {};
		const videos = objects.Video || {};
		for (const videoId in videos) {
			const video = videos[videoId];
			if (video.Content && video.Content instanceof Uint8Array) {
				estimatedSize += video.Content.length + 1024; // Add some overhead for FBX structure
			}
		}
		
		// Ensure minimum size and add some padding
		estimatedSize = Math.max(estimatedSize, 1024 * 1024); // Minimum 1MB
		estimatedSize += 1024 * 1024; // Add 1MB padding for safety
		
		const writer = new BinaryWriter(estimatedSize);


		// Write magic header
		const magic = 'Kaydara\u0020FBX\u0020Binary\u0020\u0020\0';
		writer.setString( magic );

		// Write reserved bytes (0x1A 0x00)
		writer.setUint8( 0x1A );
		writer.setUint8( 0x00 );

		// Write version (only once at header)
		writer.setUint32( this.version );

		// Write top-level nodes with correct last-sibling tracking
		const topEntries = Object.entries( fbxTree );
		for ( let i = 0; i < topEntries.length; i++ ) {
			const [name, node] = topEntries[i];
			this.writeBinaryNode( writer, name, node, this.version, 0 );
		}

		// Write null terminator node
		this.writeBinaryNode( writer, '', null, this.version );

		// Write footer
		writer.setBytes( FBX_FOOTER_ID );
		writer.setUint32( 0 );

		let offset = writer.getOffset();
		let padding = ( ( offset + 15 ) & ~15 ) - offset;
		if ( padding === 0 ) {
			padding = 16;
		}
		for ( let i = 0; i < padding; i ++ ) {
			writer.setUint8( 0 );
		}

		writer.setUint32( this.version );

		for ( let i = 0; i < 120; i ++ ) {
			writer.setUint8( 0 );
		}

		writer.setBytes( FBX_FINAL_MAGIC );

		return writer.getArrayBuffer();
	}

	writeBinaryNode( writer, name, node, version, depth = 0 ) {
		// Prevent infinite recursion
		if (depth > 100) {
			console.warn('FBX export: Maximum recursion depth exceeded, skipping node');
			return;
		}

		if ( node === null ) {
			const writeMetaValue = version >= 7500
				? ( value: number ) => writer.setUint64( value )
				: ( value: number ) => writer.setUint32( value );

			writeMetaValue( 0 );
			writeMetaValue( 0 );
			writeMetaValue( 0 );
			writer.setUint8( 0 );
			return;
		}

		// Placeholder for endOffset
		const writeMetaValue = version >= 7500
			? ( value: number ) => writer.setUint64( value )
			: ( value: number ) => writer.setUint32( value );

		const endOffsetPos = writer.getOffset();
		writeMetaValue( 0 );

		// Collect properties and subnodes
		let properties = this.collectNodeProperties( node, name );
		const subNodes = this.collectNodeSubNodes( node );

		// Hack: FBXHeaderExtension should have 0 properties
		if (name === 'FBXHeaderExtension') {
			properties = [];
		}

		// numProperties
		const numProperties = properties.length;
		writeMetaValue( numProperties );

		// Placeholder for propertyListLen, fill after writing properties
		const propertyListLenPos = writer.getOffset();
		writeMetaValue( 0 );

		// nameLen and name
		const nameBytes = BinaryWriter.encodeString( name );
		if ( nameBytes.length > 255 ) {
			throw new Error( `FBX node name too long: ${name}` );
		}
		writer.setUint8( nameBytes.length );
		writer.setBytes( nameBytes );

		const propertyListStart = writer.getOffset();

		// Write properties
		for ( const prop of properties ) {
			this.writeBinaryProperty( writer, prop );
		}

		const propertyListEnd = writer.getOffset();
		const propertyListLen = propertyListEnd - propertyListStart;
		const returnOffset = writer.getOffset();
		writer.offset = propertyListLenPos;
		writeMetaValue( propertyListLen );
		writer.offset = returnOffset;


		// Write subnodes with last-sibling tracking
		for ( let i = 0; i < subNodes.length; i++ ) {
			const [ subName, subNode ] = subNodes[i];
			this.writeBinaryNode( writer, subName, subNode, version, depth + 1 );
		}

		// Write a null sentinel only if there are child nodes.
		// This marks the end of the child list for this node as per FBX spec.
		if ( subNodes.length > 0 ) {
			this.writeBinaryNode( writer, '', null, version, depth + 1 );
		}

		// Go back and write endOffset
		const endOffset = writer.getOffset();
		const originalOffset = writer.getOffset();
		writer.offset = endOffsetPos;
		writeMetaValue( endOffset );
		writer.offset = originalOffset;

		// Ensure FBXHeaderExtension has zero properties in metadata (SDK expects this)
		if ( name === 'FBXHeaderExtension' ) {
			const save = writer.getOffset();
			// Overwrite numProps and propertyListLen with zeros
			writer.offset = endOffsetPos + ( version >= 7500 ? 8 : 4 );
			writeMetaValue( 0 );
			writer.offset = propertyListLenPos;
			writeMetaValue( 0 );
			writer.offset = save;
		}
	}

	collectNodeProperties( node, nodeName?: string ) {
		const properties: any[] = [];

		// Primitives represent a single property value
		if (typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean') {
			return [ node ];
		}

		if ( Array.isArray( node ) ) {
			// For connection arrays and other array-based nodes, treat the array elements as properties
			return [ ...node ];
		}

		// Special handling for P nodes (Properties70 properties)
		if ( node.propertyList ) {
			return node.propertyList;
		}

		// Special handling for FBXHeaderExtension - it has no direct properties in binary format
		if ( node && typeof node === 'object' ) {
			if ( 'FBXHeaderVersion' in node && 'FBXVersion' in node && 'EncryptionType' in node ) {
				return [];
			}
		}

		// Handle rawBytes containers (e.g., FileId)
		if ((node as any).rawBytes) {
			properties.push({ rawBytes: (node as any).rawBytes });
			return properties;
		}

		// Handle different node types
		if ( node.id !== undefined ) {
			// Layer and layer element indices are 32-bit integers
			if ( nodeName === 'Layer' || nodeName === 'LayerElementNormal' || nodeName === 'LayerElementUV' || nodeName === 'LayerElementTangent' || nodeName === 'LayerElementColor' ) {
				properties.push( { value: node.id, encodingType: 'I' } );
			} else {
				properties.push( { value: node.id, encodingType: 'L' } );
			}
		}
		if ( node.attrName !== undefined ) {
			const className = (node as any).fbxClass;
			if ( className && nodeName !== 'Document' ) {
				properties.push( this.formatNodeAttrName( node.attrName, className ) );
			} else {
				properties.push( node.attrName );
			}
		}
		if ( node.attrType !== undefined ) properties.push( node.attrType );

		// Special handling for FBX header nodes - they have no properties in binary format
		const isFBXHeaderNode = node.value !== undefined && typeof node.value === 'number';
		if (isFBXHeaderNode) {
			// FBX header nodes like FBXHeaderVersion have their value as a property
			properties.push(node.value);
		}


		// Handle 'a' convenience property (count) for specific structural nodes
			if ( (node as any).a !== undefined ) {
				const allowWithOthers = nodeName === 'Documents' || nodeName === 'Definitions' || nodeName === 'ObjectType';
				if ( allowWithOthers ) {
					properties.push( (node as any).a );
				} else {
					// For other nodes: include only if it's the sole key (pure array payload nodes)
					const keys = Object.keys( node ).filter( key => key !== 'dataType' );
					if ( keys.length === 1 ) {
						if ( (node as any).dataType ) {
							properties.push( { value: (node as any).a, encodingType: (node as any).dataType } );
						} else {
							properties.push( (node as any).a );
						}
					}
				}
			}

		return properties;
	}

	collectNodeSubNodes( node ) {
		const subNodes: [string, any][] = [];

		if ( Array.isArray( node ) ) {
			// Arrays don't have subnodes
			return subNodes;
		}

		// Collect all sub-nodes
		for ( const [ key, value ] of Object.entries( node ) ) {
			if ( key === 'connections' ) continue;
				if ( key === 'id' || key === 'attrName' || key === 'attrType' || key === 'a' || key === 'dataType' || key === 'propertyList' || key === 'name' || key === 'fbxClass' ) {
					continue;
				}
			// Skip connections for Connections node as it's handled as properties
			// if ( key === 'connections' && node.connections !== undefined ) {
			// 	continue;
			// }

			if ( Array.isArray( value ) ) {
				const treatAsSingleProperty =
					key === 'LocalTime' ||
					key === 'ReferenceTime' ||
					key === 'Translation' ||
					key === 'Scaling';
				if ( key === 'P' ) {
					for ( let i = 0; i < value.length; i ++ ) {
						subNodes.push( [ key, this.ensurePropertyList( value[ i ] ) ] );
					}
				} else if ( treatAsSingleProperty ) {
					const encodingType = key === 'Translation' || key === 'Scaling' ? 'D' : 'L';
					subNodes.push( [ key, { propertyList: value.map( v => ( { value: v, encodingType } ) ) } ] );
				} else {
					for ( let i = 0; i < value.length; i ++ ) {
						subNodes.push( [ key, value[ i ] ] );
					}
				}
			} else if ( key === 'Content' && value instanceof Uint8Array ) {
				subNodes.push( [ key, { propertyList: [ { rawBytes: value } ] } ] );
			} else if ( typeof value === 'object' && value !== null ) {
				const objectValue: any = value;
				if ( objectValue.id !== undefined || objectValue.attrType !== undefined || objectValue.propertyList || objectValue.a !== undefined || ! this.isDictionaryObject( objectValue ) ) {
					subNodes.push( [ key, objectValue ] );
				} else {
					for ( const child of Object.values( objectValue ) ) {
						subNodes.push( [ key, child ] );
					}
				}
			} else if ( typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ) {
				// Some numeric properties must be encoded as 64-bit (e.g., object references)
				if ( typeof value === 'number' && (key === 'RootNode') ) {
					subNodes.push( [ key, { propertyList: [ { value, encodingType: 'L' } ] } ] );
				} else {
					subNodes.push( [ key, { propertyList: [ value ] } ] );
				}
			} else {
				// Simple property, will be handled as property
			}
		}

		return subNodes;
	}	isDictionaryObject( value: any ) {
		if ( typeof value !== 'object' || value === null ) return false;
		const keys = Object.keys( value );
		if ( keys.length === 0 ) return false;
		return keys.every( key => /^-?\d+$/.test( key ) );
	}

	writeBinaryProperty( writer, prop ) {
		// Handle raw bytes (special case for FBXHeaderExtension)
		if ( prop && typeof prop === 'object' && prop.rawBytes ) {
			const raw = prop.rawBytes instanceof Uint8Array
				? prop.rawBytes
				: ArrayBuffer.isView( prop.rawBytes )
					? new Uint8Array( prop.rawBytes.buffer, prop.rawBytes.byteOffset, prop.rawBytes.byteLength )
					: new Uint8Array( prop.rawBytes );
			writer.setUint8( 'R'.charCodeAt( 0 ) ); // Raw data type
			writer.setUint32( raw.length );
			writer.setBytes( raw );
			return;
		}

		// Handle typed values
		if ( prop && typeof prop === 'object' && prop.value !== undefined && prop.encodingType ) {
			const { value, encodingType } = prop;
			if ( Array.isArray( value ) || ( ArrayBuffer.isView( value ) && ! ( value instanceof DataView ) ) ) {
				const arrayValues = Array.isArray( value ) ? value : Array.from( value as any );
				let bytesPerElement: number;
				switch ( encodingType ) {
					case 'd':
						bytesPerElement = 8;
						break;
					case 'f':
						bytesPerElement = 4;
						break;
					case 'i':
						bytesPerElement = 4;
						break;
					case 'l':
						bytesPerElement = 8;
						break;
					default:
						throw new Error( `Unsupported typed FBX array property encoding: ${encodingType}` );
				}

				writer.setUint8( encodingType.charCodeAt( 0 ) );
				writer.setUint32( arrayValues.length );
				writer.setUint32( 0 );
				writer.setUint32( arrayValues.length * bytesPerElement );

				if ( encodingType === 'd' ) {
					for ( const entry of arrayValues ) writer.setFloat64( entry );
				} else if ( encodingType === 'f' ) {
					for ( const entry of arrayValues ) writer.setFloat32( entry );
				} else if ( encodingType === 'i' ) {
					for ( const entry of arrayValues ) writer.setInt32( entry );
				} else if ( encodingType === 'l' ) {
					for ( const entry of arrayValues ) writer.setUint64( entry );
				}
			} else if ( typeof value === 'number' ) {
				if ( encodingType === 'I' ) {
					writer.setUint8( 'I'.charCodeAt( 0 ) ); // Integer
					writer.setInt32( value );
				} else if ( encodingType === 'L' ) {
					writer.setUint8( 'L'.charCodeAt( 0 ) ); // Long
					writer.setUint64( value );
				} else if ( encodingType === 'D' ) {
					writer.setUint8( 'D'.charCodeAt( 0 ) ); // Double
					writer.setFloat64( value );
				}
			} else {
				// Fallback
				this.writeBinaryProperty( writer, value );
			}
			return;
		}

		if ( typeof prop === 'number' ) {
			if ( Number.isInteger( prop ) ) {
				if ( prop >= -2147483648 && prop <= 2147483647 ) {
					writer.setUint8( 'I'.charCodeAt( 0 ) ); // Integer
					writer.setInt32( prop );
				} else {
					writer.setUint8( 'L'.charCodeAt( 0 ) ); // Long
					writer.setUint64( prop );
				}
			} else {
				writer.setUint8( 'D'.charCodeAt( 0 ) ); // Double
				writer.setFloat64( prop );
			}
		} else if ( typeof prop === 'string' ) {
			const stringBytes = BinaryWriter.encodeString( prop );
			writer.setUint8( 'S'.charCodeAt( 0 ) ); // String
			writer.setUint32( stringBytes.length );
			writer.setBytes( stringBytes );
		} else if ( typeof prop === 'boolean' ) {
			writer.setUint8( 'C'.charCodeAt( 0 ) ); // Boolean
			writer.setUint8( prop ? 1 : 0 );
		} else if ( Array.isArray( prop ) || ( ArrayBuffer.isView( prop ) && ! ( prop instanceof DataView ) ) ) {
			const arrayValues = Array.isArray( prop ) ? prop : Array.from( prop as any );
			const hasOnlyNumbers = arrayValues.every( value => typeof value === 'number' && Number.isFinite( value ) );
			if ( hasOnlyNumbers ) {
				const isIntegerArray = arrayValues.every( value => Number.isInteger( value ) );
				let typeChar: 'i' | 'd';
				let bytesPerElement: number;
				if ( isIntegerArray ) {
					typeChar = 'i';
					bytesPerElement = 4;
				} else {
					// Use double precision for floating-point arrays
					typeChar = 'd';
					bytesPerElement = 8;
				}
				writer.setUint8( typeChar.charCodeAt( 0 ) );
				writer.setUint32( arrayValues.length );
				writer.setUint32( 0 ); // encoding (0 = uncompressed)
				writer.setUint32( arrayValues.length * bytesPerElement );
				if ( isIntegerArray ) {
					for ( const val of arrayValues ) {
						writer.setInt32( val );
					}
				} else {
					for ( const val of arrayValues ) writer.setFloat64( val );
				}
			} else {
				throw new Error( `Unsupported FBX array property type: ${JSON.stringify( prop )}` );
			}
		} else if ( prop && typeof prop === 'object' ) {
			throw new Error( `Unsupported FBX property type: ${JSON.stringify( prop )}` );
		}
	}

	getDefinitionCount() {
		let count = 0;
		for ( const objects of Object.values( this.objects as any ) ) {
			count += Object.keys( objects as any ).length;
		}
		return count;
	}

	formatNodeAttrName(name: string | undefined, nodeType: string): string {
		const baseName = (name && name.length > 0) ? name : nodeType;
		return `${baseName}\x00\x01${nodeType}`;
	}

	/**
	 * Generate the most minimal FBX file possible
	 * @param binary Whether to generate binary or ASCII format
	 * @returns ArrayBuffer for binary, string for ASCII
	 */
	generateMinimalFBX(binary: boolean = false): ArrayBuffer | string {
		// Create minimal FBX tree structure
		const fbxTree: any = {
			FBXHeaderExtension: {
				FBXHeaderVersion: {
					propertyList: [1004]
				},
				FBXVersion: {
					propertyList: [this.version]
				},
				EncryptionType: {
					propertyList: [0]
				},
				CreationTimeStamp: {
					Version: 1000,
					Year: 2025,
					Month: 10,
					Day: 9,
					Hour: 12,
					Minute: 0,
					Second: 0,
					Millisecond: 0
				}
			},
			GlobalSettings: {
				Version: 1000,
				Properties70: {
					P: [
						{ property: 'UpAxis', type: 'int', value: 1 },
						{ property: 'UpAxisSign', type: 'int', value: 1 },
						{ property: 'FrontAxis', type: 'int', value: 2 },
						{ property: 'FrontAxisSign', type: 'int', value: 1 },
						{ property: 'CoordAxis', type: 'int', value: 0 },
						{ property: 'CoordAxisSign', type: 'int', value: 1 },
						{ property: 'OriginalUpAxis', type: 'int', value: 1 },
						{ property: 'OriginalUpAxisSign', type: 'int', value: 1 },
						{ property: 'UnitScaleFactor', type: 'double', value: 1.0 },
						{ property: 'OriginalUnitScaleFactor', type: 'double', value: 1.0 }
					]
				}
			},
			Documents: {
				a: 1, // Documents count as array property
				Count: 1,
				Document: {
					id: 1234567890,
					attrName: 'Scene',
					fbxClass: 'Document',
					attrType: 'Scene',
					Properties70: {
						P: [
							this.ensurePropertyList( { name: 'SourceObject', type: 'object', label: '', value: '' } ),
							this.ensurePropertyList( { name: 'ActiveAnimStackName', type: 'KString', label: '', value: '' } )
						]
					},
					RootNode: 0
				}
			},
			References: {
			},
			Definitions: {
				Version: 100,
				Count: 0,
				ObjectType: []
			},
			Objects: {},
			Connections: {
				connections: []
			},
			Takes: {
				Current: 'Take 001',
				Take: {
					attrName: 'Take 001',
					FileName: 'Take 001',
					LocalTime: [0, 46186158000],
					ReferenceTime: [0, 46186158000]
				}
			}
		};

		if (binary) {
			return this.generateBinaryFBX(fbxTree);
		} else {
			return this.generateASCIIFBX(fbxTree);
		}
	}

}

class BinaryWriter {

	buffer: ArrayBuffer;
	view: DataView;
	offset: number;
	littleEndian: boolean;
	static textEncoder = new TextEncoder();

	constructor( size: number = 16 * 1024 * 1024 ) { // 16MB default
		this.buffer = new ArrayBuffer( size );
		this.view = new DataView( this.buffer );
		this.offset = 0;
		this.littleEndian = true;
	}

	static encodeString( str: string ): Uint8Array {
		return BinaryWriter.textEncoder.encode( str );
	}

	getOffset() {
		return this.offset;
	}

	setUint8( value: number ) {
		if ( this.offset + 1 > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + 1024 ) );
		}
		this.view.setUint8( this.offset, value );
		this.offset += 1;
	}

	setInt16( value: number ) {
		if ( this.offset + 2 > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + 1024 ) );
		}
		this.view.setInt16( this.offset, value, this.littleEndian );
		this.offset += 2;
	}

	setInt32( value: number ) {
		if ( this.offset + 4 > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + 1024 ) );
		}
		this.view.setInt32( this.offset, value, this.littleEndian );
		this.offset += 4;
	}

	setUint32( value: number ) {
		if ( this.offset + 4 > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + 1024 ) );
		}
		this.view.setUint32( this.offset, value, this.littleEndian );
		this.offset += 4;
	}

	setUint64( value: number ) {
		if ( this.offset + 8 > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + 1024 ) );
		}
		// Split 64-bit value into two 32-bit parts
		const low = value & 0xFFFFFFFF;
		const high = Math.floor( value / 0x100000000 );

		if ( this.littleEndian ) {
			this.setUint32( low );
			this.setUint32( high );
		} else {
			this.setUint32( high );
			this.setUint32( low );
		}
	}

	setFloat32( value: number ) {
		if ( this.offset + 4 > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + 1024 ) );
		}
		this.view.setFloat32( this.offset, value, this.littleEndian );
		this.offset += 4;
	}

	setFloat64( value: number ) {
		if ( this.offset + 8 > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + 1024 ) );
		}
		this.view.setFloat64( this.offset, value, this.littleEndian );
		this.offset += 8;
	}

	setBytes( bytes: Uint8Array ) {
		if ( this.offset + bytes.length > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + bytes.length + 1024 ) );
		}
		for ( let i = 0; i < bytes.length; i ++ ) {
			this.setUint8( bytes[ i ] );
		}
	}

	setString( str: string ) {
		const bytes = BinaryWriter.encodeString( str );
		this.setBytes( bytes );
	}

	setArrayBuffer( buffer: ArrayBuffer ) {
		if ( this.offset + buffer.byteLength > this.buffer.byteLength ) {
			this.resize( Math.max( this.buffer.byteLength * 2, this.offset + buffer.byteLength + 1024 ) );
		}
		const sourceView = new Uint8Array( buffer );
		for ( let i = 0; i < sourceView.length; i ++ ) {
			this.setUint8( sourceView[ i ] );
		}
	}

	resize( newSize: number ) {
		if ( newSize <= this.buffer.byteLength ) return;

		const newBuffer = new ArrayBuffer( newSize );
		const newView = new Uint8Array( newBuffer );
		const oldView = new Uint8Array( this.buffer );

		newView.set( oldView );

		this.buffer = newBuffer;
		this.view = new DataView( newBuffer );
	}

	getArrayBuffer() {
		return this.buffer.slice( 0, this.offset );
	}

}

export type { FBXExportFormat, FBXExportOptions, FBXExportResult, FBXExportTarget };
export { FBXExporter };

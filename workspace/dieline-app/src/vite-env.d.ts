/// <reference types="vite/client" />

declare module 'imagetracerjs' {
	const ImageTracer: any
	export default ImageTracer
}

declare module 'clipper-lib' {
	export interface IntPoint { X: number; Y: number }
	const ClipperLib: any
	export = ClipperLib
}

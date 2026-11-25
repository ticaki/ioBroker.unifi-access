import { expect } from 'chai';

import { detectModel, featuresFor, modelHas, type DeviceCapability, type UnifiDeviceModel } from './deviceModels';

describe('deviceModels', () => {
	describe('detectModel()', () => {
		const cases: [type: string | undefined, expected: UnifiDeviceModel][] = [
			// type strings from the documented device list (api_reference 8.1)
			['UAH', 'UA-Hub'],
			['UA-G2-PRO', 'UA-G2-Pro'],
			['UDA-LITE', 'unknown'],
			// further type strings
			['UA-ULTRA', 'UA-Ultra'],
			['UA Ultra', 'UA-Ultra'],
			['UA-G3-PRO', 'UA-G3-Pro'],
			['UA-G3', 'UA-G3-Pro'],
			['UA-Hub', 'UA-Hub'],
			['UA-HUB-DOOR', 'UA-Hub'],
			['UGT', 'unknown'],
			['', 'unknown'],
			[undefined, 'unknown'],
		];
		for (const [type, expected] of cases) {
			it(`maps type ${JSON.stringify(type)} to ${expected}`, () => {
				expect(detectModel(type, type)).to.equal(expected);
			});
		}

		it('is case-insensitive', () => {
			expect(detectModel('ua-ultra', undefined)).to.equal('UA-Ultra');
			expect(detectModel('uah', undefined)).to.equal('UA-Hub');
		});

		it('evaluates the raw model and the device type', () => {
			expect(detectModel(undefined, 'UA-G3-PRO')).to.equal('UA-G3-Pro');
			expect(detectModel('UA-G3-PRO', undefined)).to.equal('UA-G3-Pro');
			expect(detectModel('something', 'UAH')).to.equal('UA-Hub');
		});

		it('prefers the more specific reader model over the hub marker', () => {
			expect(detectModel('UA-ULTRA', 'UAH')).to.equal('UA-Ultra');
			expect(detectModel('UA-G2-PRO', 'connected to UAH')).to.equal('UA-G2-Pro');
		});
	});

	describe('featuresFor() capability matrix', () => {
		const matrix: Record<UnifiDeviceModel, DeviceCapability[]> = {
			'UA-Ultra': ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
			'UA-G3-Pro': ['event-thumbnail', 'doorbell', 'door-unlock', 'live-events'],
			'UA-G2-Pro': ['event-thumbnail', 'door-unlock', 'live-events'],
			'UA-Hub': ['live-events'],
			unknown: ['live-events'],
		};
		for (const [model, capabilities] of Object.entries(matrix) as [UnifiDeviceModel, DeviceCapability[]][]) {
			it(`${model}: ${capabilities.join(', ')}`, () => {
				expect([...featuresFor(model)].sort()).to.deep.equal([...capabilities].sort());
			});
		}

		it('falls back to the "unknown" capabilities for an unexpected model value', () => {
			expect([...featuresFor('not-a-model' as UnifiDeviceModel)]).to.deep.equal(['live-events']);
		});

		it('every model receives live events', () => {
			for (const model of Object.keys(matrix) as UnifiDeviceModel[]) {
				expect(modelHas(model, 'live-events'), model).to.equal(true);
			}
		});
	});

	describe('modelHas()', () => {
		it('reports single capabilities', () => {
			expect(modelHas('UA-Ultra', 'doorbell')).to.equal(true);
			expect(modelHas('UA-G3-Pro', 'doorbell')).to.equal(true);
			expect(modelHas('UA-G2-Pro', 'doorbell')).to.equal(false);
			expect(modelHas('UA-G2-Pro', 'event-thumbnail')).to.equal(true);
			expect(modelHas('UA-Hub', 'door-unlock')).to.equal(false);
			expect(modelHas('UA-Hub', 'event-thumbnail')).to.equal(false);
			expect(modelHas('unknown', 'door-unlock')).to.equal(false);
		});
	});
});

import { useState } from 'react';
import { Alert, Checkbox, Col, Form, Input, InputNumber, Modal, Row, App as AntApp } from 'antd';
import { api } from './api';
import type { Obj } from './api';

/**
 * 自定义算力卡登记（推理评估页「自定义算力卡」口径）。
 * 峰值算力按稠密算力（TFLOPS）填写；INT4 峰值填 0 表示不支持 W4A8；
 * 工程系数按通用经验值（Prefill MFU 0.38 / Decode 带宽利用率 0.66 / KV 预留 1.10），
 * 登记后可在「当前生效的工程系数」里按该卡单独改写。
 */
export default function CustomChipModal({ open, onClose, onSaved }: {
  open: boolean; onClose: () => void; onSaved: () => void | Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  async function save() {
    let values: Obj;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await api('/inference/chips', 'POST', values);
      message.success('自定义算力卡已登记，可直接在全局硬件配置里选用');
      form.resetFields();
      onClose();
      await onSaved();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="登记自定义算力卡" open={open} onCancel={onClose} onOk={() => void save()}
      okText="保存" cancelText="取消" width={680} confirmLoading={saving} destroyOnHidden>
      <Alert type="info" showIcon className="below"
        message="按厂商规格填写：显存 / HBM 带宽决定显存约束与 Decode 带宽下限，互联带宽用于机内 TP 通信开销折算，功耗仅作信息展示。INT4 峰值填 0 表示该卡不支持 W4A8。" />
      <Form form={form} layout="vertical" preserve={false}
        initialValues={{ int4_tflops: 0, power_kw: 0, native_int4: false }}>
        <Row gutter={16}>
          <Col span={8}><Form.Item name="key" label="标识" rules={[{ required: true, message: '请填写标识' }]}>
            <Input placeholder="my-card-v1" /></Form.Item></Col>
          <Col span={16}><Form.Item name="label" label="显示名称">
            <Input placeholder="某厂商 96GB 推理卡（选填）" /></Form.Item></Col>
          <Col span={8}><Form.Item name="bf16_tflops" label="BF16/FP16 峰值 (T)" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="int8_tflops" label="INT8/FP8 峰值 (T)" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="int4_tflops" label="INT4 峰值 (T，0 为不支持)">
            <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="memory_gb" label="显存容量 (GB)" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="hbm_tbs" label="HBM 带宽 (TB/s)" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={0.1} step={0.1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="link_gbs" label="卡间互联带宽 (GB/s 单向)" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="power_kw" label="单卡功耗 (kW，选填)">
            <InputNumber min={0} step={0.05} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={16}><Form.Item name="native_int4" valuePropName="checked" label="原生 INT4">
            <Checkbox>该卡具备原生 INT4 峰值（可选 W4A8 精度）</Checkbox></Form.Item></Col>
        </Row>
      </Form>
    </Modal>
  );
}

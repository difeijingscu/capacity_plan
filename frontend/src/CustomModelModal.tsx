import { useState } from 'react';
import { Alert, Button, Col, Form, Input, InputNumber, Modal, Row, App as AntApp } from 'antd';
import { api } from './api';
import type { Obj } from './api';

/**
 * 清单外模型的结构登记。业务场景页与推理评估页共用同一份表单，
 * 避免两处字段口径漂移（少一个 head_dim 就会让显存估算差一截）。
 */
export default function CustomModelModal({ open, onClose, onSaved }: {
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
      await api('/inference/models', 'POST', values);
      message.success('自定义模型已登记，可直接在场景里选用');
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
    <Modal title="登记自定义模型" open={open} onCancel={onClose} onOk={() => void save()}
      okText="保存" cancelText="取消" width={720} confirmLoading={saving} destroyOnHidden>
      <Alert type="info" showIcon className="below"
        message="字段与内置模型一致；激活参数对 MoE 填「每个 token 实际参与计算」的参数量。" />
      <Form form={form} layout="vertical" preserve={false}
        initialValues={{ arch: 'Dense', kv_heads: 8, head_dim: 128, gqa_kv_fraction: 1, ffn_mul: 2.5, rope_dim: 0, attn_span: 0 }}>
        <Row gutter={16}>
          <Col span={8}><Form.Item name="key" label="标识" rules={[{ required: true, message: '请填写标识' }]}>
            <Input placeholder="my-model-v1" /></Form.Item></Col>
          <Col span={16}><Form.Item name="label" label="显示名称">
            <Input placeholder="自研 30B（选填）" /></Form.Item></Col>
          <Col span={8}><Form.Item name="total_b" label="总参数 (B)" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={0.1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="active_b" label="激活参数 (B)" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={0.1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="hid" label="隐层维度" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={128} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="layers" label="层数" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="heads" label="Q 头数" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="kv_heads" label="KV 头数">
            <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="head_dim" label="每头维度">
            <InputNumber min={8} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="kv_head_dim" label="KV 头维度（留空同每头）">
            <InputNumber min={8} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="ffn_mul" label="FFN 扩张倍数">
            <InputNumber min={0.1} step={0.1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="gqa_kv_fraction" label="全注意力层占比">
            <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="experts" label="专家数（MoE 填）">
            <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="top_k" label="Top-K（MoE 填）">
            <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="attn_span" label="注意力跨度上限（0 不限）">
            <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="latent_dim" label="MLA 低秩维度（留空非 MLA）">
            <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="rope_dim" label="RoPE 维度">
            <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="qk_head_dim" label="MLA QK 头维度">
            <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="v_head_dim" label="MLA V 头维度">
            <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
        </Row>
      </Form>
    </Modal>
  );
}

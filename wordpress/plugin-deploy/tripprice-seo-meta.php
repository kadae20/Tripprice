<?php
/**
 * Plugin Name: Tripprice SEO Meta
 * Plugin URI:  https://tripprice.net
 * Description: Yoast SEO 메타 필드(focuskw, title, metadesc, canonical, linkdex, content_score)를 WP REST API에 노출합니다. wp-publish.js 연동용.
 * Version:     1.1.0
 * Author:      Tripprice
 */

defined('ABSPATH') || exit;

add_action('rest_api_init', static function () {
    $meta_config = [
        '_yoast_wpseo_focuskw'       => ['maxLength' => 100,  'sanitize' => 'sanitize_text_field'],
        '_yoast_wpseo_title'         => ['maxLength' => 100,  'sanitize' => 'sanitize_text_field'],
        '_yoast_wpseo_metadesc'      => ['maxLength' => 300,  'sanitize' => 'sanitize_text_field'],
        '_yoast_wpseo_canonical'     => ['maxLength' => 2083, 'sanitize' => 'esc_url_raw'],
        '_yoast_wpseo_linkdex'       => ['maxLength' => 10,   'sanitize' => 'sanitize_text_field'],
        '_yoast_wpseo_content_score' => ['maxLength' => 10,   'sanitize' => 'sanitize_text_field'],
    ];

    foreach ($meta_config as $key => $cfg) {
        register_post_meta('post', $key, [
            'type'              => 'string',
            'single'            => true,
            'show_in_rest'      => [
                'schema' => [
                    'type'      => 'string',
                    'maxLength' => $cfg['maxLength'],
                ],
            ],
            'default'           => '',
            'sanitize_callback' => $cfg['sanitize'],
            'auth_callback'     => static function ($allowed, $meta_key, $post_id) {
                return current_user_can('edit_post', $post_id);
            },
        ]);
    }
}, 11);
